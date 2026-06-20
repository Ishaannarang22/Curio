# Voice agent

The realtime voice pipeline, built on [Pipecat](https://docs.pipecat.ai) 1.3.0.
It owns audio in/out, turn-taking, the LLM conversation, optional message
persistence, and observability. The orchestration layer was ported from Pulse
and genericized — the conversation's *purpose* is driven entirely by the
`systemPrompt`/`opener` in the session payload, so it can be repurposed without
touching the pipeline.

## Setup & run

```bash
cd agent
uv sync          # installs pinned deps into .venv
uv run bot.py    # starts the dev runner on http://localhost:7860
```

Useful flags: `uv run bot.py --host 0.0.0.0 --port 7860 -t webrtc`.
A built-in test client lives at `http://localhost:7860/client` (it connects
without a `session` payload — the bot then uses a fallback prompt and skips
persistence, which is fine for audio testing).

## Env vars

Loaded from `agent/.env` (optional) and then the repo root `.env.local`
(python-dotenv with explicit paths), so the app's existing keys just work:

| Var | Used for |
| --- | --- |
| `DEEPGRAM_API_KEY` | Flux STT + end-of-turn detection |
| `CARTESIA_API_KEY` | TTS |
| `AI_GATEWAY_API_KEY` | If set: LLM via Vercel AI Gateway (`https://ai-gateway.vercel.sh/v1`), model taken from the session payload `model` field (or `AI_GATEWAY_MODEL`) |
| `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODEL` | LLM via NVIDIA NIM (used when no gateway key) |
| `ZAI_BASE_URL`, `ZAI_API_KEY`, `ZAI_MODEL` | Final fallback LLM (any OpenAI-compatible endpoint) |
| `SENTRY_DSN` | Errors + tracing for the agent (falls back to `NEXT_PUBLIC_SENTRY_DSN`). Optional — agent runs fine without it. |
| `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Optional Sentry tuning (defaults: `development`, `1.0`) |

LLM precedence: **AI Gateway → NVIDIA NIM → OpenAI-compatible (`ZAI_*`)**.

## Observability (Sentry)

When `SENTRY_DSN` is set, `_init_sentry()` runs at process start. The loguru
integration forwards log records automatically (INFO+ as breadcrumbs, ERROR+ as
events), so every `logger.error(...)` reaches Sentry. On top of that:

- each session runs inside a `voice.session` transaction (duration tracing);
- the LLM model and conversation id are attached as tags;
- persistence failures and fatal session errors are explicitly captured.

The agent shares the same Sentry project as the Next.js app by default (set
`SENTRY_DSN` to the project's DSN, or it falls back to `NEXT_PUBLIC_SENTRY_DSN`).

## Session handshake (contract with a client)

1. The browser POSTs its WebRTC offer to **`POST http://localhost:7860/api/offer`**
   with JSON `{ sdp, type, request_data: { session: {...} } }`. The runner also
   accepts the camelCase key `requestData` (this is what pipecat client-js
   sends when you set `requestData` in the SmallWebRTC transport connect
   params). CORS is open in the dev runner.
2. The runner hands that object to the bot as `runner_args.body`; the bot reads
   `runner_args.body["session"]`:

   ```json
   {
     "conversationId": "...", "accessToken": "...",
     "supabaseUrl": "...", "supabaseAnonKey": "...",
     "systemPrompt": "...", "opener": "...", "model": "..."
   }
   ```

   All fields are optional. Without `systemPrompt`, a neutral fallback prompt is
   used. Without the four Supabase fields, persistence is skipped.
3. On connect, the agent speaks `opener` (seeds it into the LLM context but
   never persists it), then listens.
4. After each final user utterance and each completed assistant turn — *if*
   Supabase credentials were supplied — the bot POSTs to
   `{supabaseUrl}/rest/v1/messages` with the user's own `accessToken` as the
   Bearer token (so Supabase RLS applies), the anon key as `apikey`, and body
   `{conversation_id, role, content}`. Writes are fire-and-forget. Expected
   table: `messages(conversation_id, role, content)`.
5. Live captions: the pipeline auto-includes an RTVI processor/observer, which
   streams user/bot transcription events to the client over the data channel.

## Tuning knobs (`tuning.py`)

All the "weights" that make the conversation feel human live in `tuning.py`,
with detailed comments. Plain-language summary:

| Knob | Default | What it does |
| --- | --- | --- |
| `ALLOW_INTERRUPTIONS` | `True` | If off, the agent always finishes its sentence. |
| `BACKCHANNEL_MIN_WORDS` | `3` | Words you must say *while the agent is talking* before it shuts up. Keeps "yeah / mm-hmm / right / laughter" from cutting it off, and bakes in ~300-800ms of natural overlap before it yields. When the agent is silent, 1 word starts your turn. |
| `INTERRUPT_ON_PARTIAL_TRANSCRIPTS` | `True` | Count your words live (mid-utterance) so the agent yields with human-like overlap. Off = it only yields after you finish your whole interjection. |
| `FLUX_EOT_THRESHOLD` | `0.7` | How sure Deepgram Flux must be that you're done talking. Lower = snappier replies but may cut you off mid-thought; higher = more patient but laggier. |
| `FLUX_EAGER_EOT_THRESHOLD` | `None` | Optional early "probably done" signal for lower latency (try `0.5`); costs extra LLM calls. |
| `FLUX_EOT_TIMEOUT_MS` | `5000` | Silence ceiling: turn ends after this long no matter what. Big value = you can pause and think mid-sentence. |
| `FLUX_MODEL` | `flux-general-en` | `flux-general-multi` for multilingual. |
| `USER_TURN_SETTLE_SECS` | `0.3` | Grace window for straggler transcripts before the LLM is triggered. Adds directly to reply latency. |
| `USER_TURN_STOP_TIMEOUT_SECS` | `5.0` | Watchdog so a wedged turn can't stall the conversation. |
| `TTS_VOICE_ID` | Tessa - Kind Companion | Cartesia voice (warm, calm, female). Pick others at play.cartesia.ai/voices. |
| `TTS_MODEL` | `sonic-3` | Cartesia model. |
| `TTS_SPEED` | `1.0` | 0.6–1.5. |
| `TTS_VOLUME` | `1.0` | 0.5–2.0. |
| `TTS_EMOTION` | `None` | Optional Sonic-3 emotion hint (e.g. `"content"`). |
| `SPEAK_OPENER` | `True` | Voice the server-provided opener on connect. |

Note on yielding: when the agent does yield, pipecat performs a hard audio cut
(no fade-out exists in pipecat 1.3.0); the min-words overlap is what keeps
interruptions feeling natural. Reply length is governed by the system prompt
(short by design), not by any token limit in code.

## Architecture

See the docstring at the top of `bot.py` for the full pipeline diagram
(audio in → Flux STT/turn-taking → context → LLM → Cartesia TTS → audio out),
the interruption flow, the persistence flow, and observability.
