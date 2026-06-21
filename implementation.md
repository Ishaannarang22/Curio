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
| Voice agent        | **Existing, pre-built** (owner already built it). To be **integrated**. Contract TBD — see §3. |
| LLM / agent runtime| Default to latest Claude models (**Opus 4.8** `claude-opus-4-8` / **Sonnet 4.6** `claude-sonnet-4-6`) unless a reason emerges otherwise. |
| STT / TTS          | Owned by the existing voice agent (see §3).                         |
| Observability      | **Sentry** (`@sentry/nextjs` v10) — errors, tracing, and **agent call/usage observability** (see §4). |
| Backend / orchestration | TBD.                                                           |
| Persistence        | TBD (raw transcripts are the durable source of truth — storage model not yet chosen). |

---

## 3. Voice agent integration — OPEN

The voice agent already exists and will be dropped in. The integration **contract is
not yet defined.** To resolve once the code is provided:

- **What it emits:** partial vs. finalized transcript chunks? event format? timing?
- **What it accepts:** can we push it text to *speak* (for clarifying questions / gap
  prompts)? Or is talk-back not wired yet?
- **Who owns the conversation:** does the voice agent decide what to say on its own
  (black box), or does our inference layer drive the talk-back? (Matters so the agent
  and our system don't both try to "talk".)
- **STT/TTS providers** live inside it — document them once known.

➡️ **Action:** owner will share the voice-agent code; update this section and §2 then.

---

## 4. Sentry agent observability

Sentry is our single tool for **observing every LLM/agent call** — latency, failures,
and token usage — in addition to general app error monitoring. The SDK wiring
(three `Sentry.init()` calls, source maps, tunnel route) is documented in
[CLAUDE.md](./CLAUDE.md); this section covers **how to instrument the agent pipeline.**

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

- **Voice-agent contract** (the whole of §3).
- **Topic-tree representation** — how the implicit hierarchy is stored and kept in sync
  with the spatial canvas.
- **Region reservation mechanics** — what defines a region's bounds; what happens when a
  topic outgrows its reserved space.
- **Persistence** — storage model for the durable raw transcripts (see also
  [prd.md](./prd.md) §"Open product questions").
- **Platform** — web / desktop / mobile first?
