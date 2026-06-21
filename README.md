# Curio

**A voice-first AI study companion that turns talking out loud into a living whiteboard.**

Curio is built around the [Feynman technique](https://en.wikipedia.org/wiki/Learning_by_teaching): the best way to learn something is to explain it. You talk through a topic out loud, and Curio listens like an attentive tutor — encouraging you to keep going, gently asking a question when you skip over something — while a separate brain quietly turns your explanation into a live [tldraw](https://tldraw.dev) board of structured notes, diagrams, flowcharts, and mind maps in real time.

**Voice is the input. The board is the output.** You walk away with a study artifact you built yourself, just by thinking out loud.

---

## How it works

Curio runs as a **dual-channel** system — two brains working off the same live transcript:

```
                                   ┌─ Speaking agent ──→ talks back to you (TTS)
your voice ──→ STT + turn-taking ──┤
                                   └─ Caller channel ──→ structures the board
```

- **Speaking agent** — holds a natural conversation: encourages you, asks
  clarifying questions, never lectures. It doesn't touch the board.
- **Caller channel** — watches the transcript, detects where one topic ends and
  the next begins (a recursive topic tree), and hands each finished topic to a
  **Structuring Agent** that decides how to draw it. It talks to the board
  through a tool vocabulary (`addFlowchart`, `addMindMap`, `connectNodes`, …)
  instead of dumping raw text.

The board updates over a live stream, so what you say becomes structure on screen
within seconds.

## Tech stack

| Layer | Tech |
| --- | --- |
| **Web app** | Next.js (App Router) · React 19 · TypeScript · Tailwind |
| **Whiteboard** | tldraw · TipTap · ELK / d3-force (layout) · Framer Motion |
| **Voice agent** | Python · [Pipecat](https://docs.pipecat.ai) (WebRTC) |
| **Speech-to-text** | Deepgram Flux (STT + semantic turn-taking) |
| **Text-to-speech** | Cartesia Sonic-3 |
| **LLM** | OpenAI-compatible, via Vercel AI Gateway → NVIDIA NIM → Z.ai/GLM |
| **Data** | Supabase (Postgres + Row-Level Security) · Redis (optional board state) |
| **Observability** | Sentry (errors, tracing, agent spans + token usage) |

## Repository layout

| Path | What's in it |
| --- | --- |
| `app/`, `components/` | Next.js web app + the tldraw whiteboard UI |
| `app/api/board/` | The live bridge that streams agent commands to the board |
| `agent/` | The Pipecat voice agent (see [`agent/README.md`](./agent/README.md)) |
| `idea.md` | The **why** — product vision and the Feynman bet |
| `prd.md` | The **what** — the capture→structure loop, data model, decisions |
| `implementation.md` | The **how** — agent topology, tech stack, integration contract |

## Getting started

Curio runs two processes: the **web app** (`:3000`) and the **voice agent** (`:7860`).

**1. Configure environment**

```bash
cp .env.example .env.local
```

Fill in `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, and one LLM key
(`AI_GATEWAY_API_KEY`, `NVIDIA_API_KEY`, or `ZAI_API_KEY`). `.env.local` is read
by both the web app and the agent. Supabase and Sentry are optional.

**2. Run the web app**

```bash
npm install
npm run dev          # → http://localhost:3000
```

**3. Run the voice agent**

```bash
cd agent
uv sync              # installs pinned deps
uv run bot.py        # → http://localhost:7860
```

Open the app, click the orb, and start talking.

## Tuning the conversation

Everything that makes the agent feel human — interruption tolerance, backchannel
handling (a quick "mm-hmm" shouldn't cut it off), end-of-turn sensitivity, voice
and speed — lives in `agent/tuning.py`, each knob documented inline.

## Privacy by design

Voice and transcripts are sensitive, so storage is **optional and off by
default**. When enabled, every write goes through Supabase Row-Level Security
using the user's own access token — there is no backend key that can read
everyone's notes — and error monitoring is configured to never collect personal
data. Curio is also deliberately anti-cheating: it never hands you answers to
copy, it just helps you explain things better yourself.
