# implementation.md — Architecture & integration

> The "how" of Curio: agent topology, tech stack, the voice-agent integration
> contract, and observability. See [idea.md](./idea.md) for vision and
> [prd.md](./prd.md) for the requirements this realizes. Living document.

> ⚠️ **Next.js caveat:** this repo runs a Next.js version with breaking changes vs.
> training data. Read the relevant guide in `node_modules/next/dist/docs/` before
> writing app code (see [AGENTS.md](./AGENTS.md)).

---

## 1. Agents & pipeline

The "pipeline" between the voice agent and the specialized agents. Resolved topology:

```
  speech
    │
    ▼
┌───────────────┐   live, ungated
│  Voice Agent  │ ─────────────────▶ verbatim nodes appear on canvas
│  (existing)   │      transcript
└──────┬────────┘
       │ transcript stream
       ▼
┌────────────────────┐   fires at a TOPIC BOUNDARY (not per-chunk)
│  Inference Layer    │   = dispatcher / classifier (NOT an agent)
│  - is a clarifying  │   - decides which agents wake up
│    question needed? │   - decides if/what to ask
│  - is there a gap?  │
│  - wrong-path note? │
└─────┬──────────┬────┘
      │          │  (parallel)
      ▼          ▼
┌───────────┐ ┌───────────┐
│Structuring│ │ Spawner   │   real agents — they ACT (propose canvas ops)
│  Agent    │ │  Agent    │
└─────┬─────┘ └─────┬─────┘
      │ propose ops │ propose ops
      ▼             ▼
   ┌─────────────────────┐
   │  Canvas Writer      │  single serialized writer → commits ops
   │  (one mutation API) │  → home of erase/refine animations
   └──────────┬──────────┘
              ▼
        ┌───────────┐
        │ Whiteboard│ (forked tldraw)
        └───────────┘
```

### 1.1 Inference Layer — a dispatcher, not an agent

- **Not its own agent.** It's a stateless classifier/router: input = the sealed
  topic's content; output = a verdict (does this need a clarifying question? is there a
  gap? did the student go off-path?) and a routing decision (which agents to wake).
- Runs at **topic boundaries**, not on every chunk — keeps the hot path cheap.
- **Grounding: model knowledge only.** No uploaded syllabus/textbook in v1. Judgments
  about gaps / wrong-path come from the LLM's own knowledge. (Trade-off accepted:
  simplest path; risk of imperfect judgments on niche/advanced topics.)

### 1.2 Structuring Agent

- Reads a sealed topic's **raw transcript** and emits a structured projection.
- Chooses the form from the content's shape; the student can override by voice. See
  [prd.md](./prd.md) §"Structured output requirements".

**Implemented** (`agent/structuring_agent.py`, fired by the boundary processor's
`on_seal` seam). Two stages per seal, both Sonnet 4.6 (`ROUTER_MODEL` /
`STRUCTURING_MODEL`, env-overridable):

1. **Router** — reads `SealEvent.raw` → `{needs_restructure, format}` where
   `format ∈ {flowchart, diagram, mindmap}`. `needs_restructure=false` → leave the
   verbatim raw block untouched (no render).
2. **Renderer** — **forced** to the locked format's composite tool, builds the
   artifact from the raw. The block id is pinned to the node id (not the model's
   echo) so the artifact replaces the raw block in place.

Seal kinds: `leaf` → one artifact at the node's block; `parent` → **MERGE** to one
consolidated artifact, then remove the provisional child blocks
(`SealEvent.descendant_ids`). Always **write-then-remove** (no blank flash).

Runtime: `on_seal` enqueues and returns instantly; a **single background worker**
drains the queue sequentially — keeping the boundary hot path unblocked and
serializing every board write (a de-facto single Canvas Writer until §1.5 lands). It
shares **one `BoardState`** with the boundary processor so placement avoids
overlapping un-structured raw and replacement is in-place. Renders direct to the
bridge via `execute_tool_call`. Each seal is one `gen_ai.invoke_agent` Sentry span
(`curio.agent="structuring"`, `curio.topic_id`, token usage). See §4.

**`make_diagram`** (new, 16th board tool): a free-form relationship graph
(`nodes[]` + labelled `edges[]`) laid out client-side by a **general d3-force** pass —
distinct from the mind-map's radial star and the flowchart's ELK sequence.

**Non-overlap.** Every create tool now **estimates its footprint** (`estimate_size`)
*before* placing — flowchart height ≈ steps, mind-map/diagram diameter ≈ node count,
notes ≈ text length — and `resolve_placement` lattice-packs against the real stored
bboxes (no more fixed `480×320` placeholder). Center-anchored formats (mind-map,
diagram) convert the packer's top-left slot to a centre so their spread stays inside
the reserved region. (Geometry write-back from the board stays a later cosmetic
refinement; an estimate is required up front anyway — you reserve space before the
board lays the shape out.)

### 1.3 Spawner Agent

- Runs **in parallel** with the Structuring Agent on the same sealed topic.
- Generates **side study artifacts** (sticky notes, definitions, flashcards). See
  [prd.md](./prd.md) §"Study artifact requirements".

### 1.4 Concurrency — how the two agents don't stomp each other

Two independent guarantees, used together:

1. **Spatial: different spaces per agent.** Structuring transforms the topic's main
   region; the Spawner places its artifacts in a separate region (margin/sidebar
   around the topic). An agent reserves its space before working so the other knows
   "occupied / agent working here — don't step on it."
2. **Data: both read the sealed, immutable raw.** Neither agent consumes the other's
   output. Both derive independently from the topic's raw transcript (immutable once
   sealed). This removes the dangling-reference race (Structuring can merge/delete its
   own nodes without breaking the Spawner, because the Spawner never pointed at them).

### 1.5 Canvas Writer (recommended pattern — to confirm during build)

Agents **propose** operations ("create node", "move A→here", "merge B,C"); a **single
canvas writer** applies them **one at a time** and repairs/rejects ops against stale
state. This one chokepoint kills layout-fights, lost-updates, and dangling refs, and
is the natural home for the **erase/refine animations**.

---

## 2. Tech stack

| Concern            | Decision                                                            |
|--------------------|---------------------------------------------------------------------|
| Whiteboard canvas  | **Fork tldraw**, build custom node types / behaviors on top. (License is a non-issue for a hackathon; tldraw is the stronger engine vs. Excalidraw.) |
| App framework      | **Next.js** (see Next.js caveat above). |
| Voice agent        | **Our fork** of the pulse **Pipecat 1.3.0** scaffold in `agent/` (`bot.py`). Reference/starting point we own and rewrite — not an external component. Audio I/O, turn-taking, persistence, Sentry over **SmallWebRTC**. See §3. |
| STT + turn-taking  | **Deepgram Flux** (`flux-general-en`) — STT *and* semantic end-of-turn in one service; backchannel tolerance via a min-words strategy. |
| TTS                | **Cartesia Sonic-3** (`sonic-3`). Voice/speed/emotion knobs in `agent/tuning.py`. |
| Voice LLM "brain"  | **OpenAI-compatible**, resolved by precedence: Vercel AI Gateway → NVIDIA NIM → ZAI fallback. Model comes from the session payload `model` field. **Not Claude by default** (but AI Gateway can route to Claude). Distinct from our structuring/spawner/inference agents. |
| Our agent runtime  | Default to latest Claude models (**Opus 4.8** `claude-opus-4-8` / **Sonnet 4.6** `claude-sonnet-4-6`) for the Inference Layer / Structuring / Spawner agents. |
| Observability      | **Sentry** — `@sentry/nextjs` v10 in the web app, `sentry_sdk` in the Python agent (shares the same DSN). Errors, tracing, and **agent call/usage observability** (see §4). |
| Persistence        | **Supabase** (Postgres + PostgREST). The voice agent writes finalized turns to `messages(conversation_id, role, content)` with the end-user's JWT so **RLS** applies. Raw transcripts are the durable source of truth (see [prd.md](./prd.md) §1.4). |
| Backend / orchestration | Next.js app + the Python voice agent process; canvas-op orchestration (Inference → agents → Canvas Writer) is ours to build. |

---

## 3. Voice agent — fork base (pulse)

`agent/` (Pipecat 1.3.0, ported from "Pulse") is **scaffolding / reference we fork
from, not a fixed external component we integrate against.** The real voice
implementation is **ours** — we own the code and modify it freely. What follows is the
behavior we **inherit from the fork** (the starting point), and what we change. Source
of truth for the inherited behavior is the `bot.py` docstring and `agent/README.md`.

### 3.1 Session handshake (inherited)

The browser POSTs its WebRTC offer to **`POST http://localhost:7860/api/offer`** as
JSON `{ sdp, type, request_data: { session: {...} } }` (pipecat client-js sends the
key as `requestData`; the agent normalizes it). The `session` payload — all fields
optional:

```json
{ "conversationId": "...", "accessToken": "...", "supabaseUrl": "...",
  "supabaseAnonKey": "...", "systemPrompt": "...", "opener": "...", "model": "..." }
```

- Without `systemPrompt`, a neutral fallback prompt is used.
- Without the four Supabase fields, **persistence is skipped** (pipeline still runs).
- On connect the agent **speaks the `opener`** (via `TTSSpeakFrame`, bypassing the
  LLM) and seeds it into context, then listens.

### 3.2 What it emits

- **Live captions (our live verbatim feed):** the pipeline auto-installs an
  `RTVIProcessor` + `RTVIObserver`, streaming user/bot transcription events to the
  client **over the WebRTC data channel**. This is the path for writing verbatim nodes
  to the canvas live (see [prd.md](./prd.md) §1.1).
- **Finalized turns → Supabase:** on `on_user_turn_stopped` / `on_assistant_turn_stopped`
  the agent fire-and-forget POSTs to `{supabaseUrl}/rest/v1/messages` with the user's
  JWT (RLS-safe). The opener is *not* persisted by the agent.

### 3.3 Turn-taking granularity

Deepgram Flux decides **utterance-level** turn boundaries (semantic EndOfTurn +
backchannel tolerance). Our **topic boundaries** (see [prd.md](./prd.md) §1.2) are a
higher-level concept computed on top of the utterance stream by a **per-turn topic
classifier** running in the Python voice backend: each EndOfTurn utterance →
`CONTINUE / DESCEND / SIBLING / ASCEND / RETURN` verdict against a recursive topic
tree (fast/cheap model, Haiku-class — distinct from the Structuring Agent it fires).
Sealing is semantic only (no timers); the trailing topic seals on session end. This
classifier is the **hook that fires the Structuring Agent** (and, in parallel, the
Spawner Agent). See [prd.md](./prd.md) §1.2–1.3 decisions #19–22.

**Implemented (replaces the `board_writer.py` prototype's idle-timer model):**

| Module | Role |
| --- | --- |
| `agent/topic_tree.py` | Pure, I/O-free recursive topic tree. Applies a verdict, attributes the utterance to the **destination** node, and emits `SealEvent`s (leaf seal → node's own raw; parent seal → whole-subtree raw). The semantics live here and are unit-tested exhaustively (`tests/test_topic_tree.py`). |
| `agent/topic_classifier.py` | The cheap per-turn LLM classifier. One forced `emit_verdict` tool call per utterance; any error/ambiguity degrades to `CONTINUE` (a missed boundary is recoverable; a spurious seal is not). Haiku-class via the AI Gateway, `CLASSIFIER_MODEL`-overridable. |
| `agent/topic_boundary.py` | `TopicBoundaryProcessor` — the pipecat observer wired into `bot.py` where `BoardWriter` used to sit. Per turn: classify → apply → mirror the active node's verbatim raw to the board (prd §1.1) → fire each `SealEvent` through the **seal seam** (`on_seal`). |

The **seal seam** (`on_seal: (SealEvent) -> awaitable`) is the Structuring Agent's
trigger contract. Until that agent is built it defaults to a logger, so the boundary
engine runs live and observable but the board shows raw per-topic blocks rather than
artifacts (intentional, temporary regression). `board_writer.py` stays on disk as a
harvestable prototype (BoardState / BridgePoster / tool schemas) but is **no longer
wired** into the pipeline.

### 3.4 Talk-back ownership — DECIDED: our system is the brain

The current pulse pipeline is a **per-turn conversational companion**: after every
user turn its own OpenAI-compatible LLM brain generates a spoken reply. Curio's design
(decisions #4/#5 in [prd.md](./prd.md)) wants the bot **mostly silent**, talking back
only *sometimes* and only at **pauses/topic boundaries**, with our **Inference Layer**
deciding if/what to say.

**Decision (#18):** pulse is reduced to an **STT/TTS transport**; Curio is the brain.

```
Flux STT --> transcription stream --> [Inference Layer + agents]
                                              |  decides if/what to say
                                              v
                          pulse.speak(text)  -->  Cartesia TTS
```

- pulse's **per-turn LLM brain is removed from the speaking path** — it no longer
  auto-replies each turn.
- We consume the transcription stream (RTVI / persisted turns, §3.2) as the canvas feed.
- **All** talk-back is driven by us: the Inference Layer decides at topic boundaries,
  then we push text for the agent to speak.

### 3.5 What we change in our fork

Since the agent is **ours to rewrite** (not an external API), these are direct edits to
the forked pipeline, not an integration shim:

1. **Add an inbound "speak this" channel.** Today only the `opener` injects a
   `TTSSpeakFrame`. Generalize that into an on-demand path (e.g. a control message over
   the WebRTC data channel, or a small local endpoint) so Curio can make the agent speak
   arbitrary text mid-session.
2. **Decouple the per-turn LLM from the speaking path.** Drop `OpenAILLMService` + the
   assistant aggregator from the pipeline (or keep context aggregation but stop it
   auto-replying). Keep Flux STT, turn detection, and the transcription stream intact.
3. **Preserve persistence + observability.** The Supabase user-turn writes (§3.2) and
   the `voice.session` Sentry transaction (§4) stay; assistant-turn writes now reflect
   only what *we* chose to speak.

➡️ **Status:** §3.1–3.4 settled; §3.5 is the rewrite to-do once we build.

---

## 4. Sentry agent observability

Sentry is our single tool for **observing every LLM/agent call** — latency, failures,
and token usage — in addition to general app error monitoring. The SDK wiring
(three `Sentry.init()` calls, source maps, tunnel route) is documented in
[CLAUDE.md](./CLAUDE.md); this section covers **how to instrument the agent pipeline.**

> The **voice agent already emits Sentry** from Python (`sentry_sdk`): each session
> runs inside a `voice.session` transaction with `service=voice-agent`, `llm.model`,
> and `conversation.id` tags, and it shares the app's DSN (falls back to
> `NEXT_PUBLIC_SENTRY_DSN`). Instrument **our** Inference/Structuring/Spawner/Canvas
> agents (below) into the **same** project so a study session is traceable end-to-end.

### 4.1 Wrap every agent call in a span

Each unit of the pipeline (§1) gets its own traced span so a topic-boundary event
produces one trace with child spans per agent:

```ts
import * as Sentry from "@sentry/nextjs";

await Sentry.startSpan(
  {
    name: "structuring-agent",
    op: "gen_ai.invoke_agent",        // use gen_ai.* ops so spans group as AI calls
    attributes: {
      "gen_ai.request.model": "claude-opus-4-8",
      "curio.agent": "structuring",
      "curio.topic_id": topicId,
    },
  },
  async (span) => {
    const res = await callModel(/* ... */);

    // record usage so cost/volume is queryable in Sentry
    span.setAttribute("gen_ai.usage.input_tokens", res.usage.input_tokens);
    span.setAttribute("gen_ai.usage.output_tokens", res.usage.output_tokens);
    return res;
  },
);
```

Instrument these spans:

| Span | `curio.agent` tag | Notes |
| --- | --- | --- |
| Inference Layer dispatch | `inference` | Records the verdict (question? gap? wrong-path?) and which agents were woken. |
| Structuring Agent | `structuring` | One span per sealed topic structuring run. |
| Spawner Agent | `spawner` | Runs in parallel with structuring — sibling spans under the same trace. |
| Canvas Writer commit | `canvas-writer` | Op apply/repair/reject; not an LLM call but worth tracing for layout-fight debugging. |

### 4.2 Usage tracking

- Record `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (and the model id)
  as span attributes on **every** model call so spend and volume are queryable per
  agent and per topic.
- Tag spans with `curio.agent` and `curio.topic_id` so usage can be sliced by which
  agent and which study session drove it.

### 4.3 Failures & logs

- `Sentry.captureException(error)` on any agent failure; attach `Sentry.setTag("agent", ...)`
  for searchability.
- `enableLogs: true` is on — emit structured logs for agent decisions (e.g. inference
  verdicts, rejected canvas ops) so they're correlated with the trace.

---

## 5. Open technical questions

- **Topic-tree representation** — how the implicit hierarchy is stored and kept in sync
  with the spatial canvas.
- **Region reservation mechanics** — what defines a region's bounds; what happens when a
  topic outgrows its reserved space.
- **Persistence** — storage model for the durable raw transcripts (see also
  [prd.md](./prd.md) §"Open product questions").
- **Platform** — web / desktop / mobile first?
