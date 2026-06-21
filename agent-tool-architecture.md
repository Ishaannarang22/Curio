# agent-tool-architecture.md — Agents-as-tools (voice orchestrator ↔ board)

> The settled design for how the voice agent drives the whiteboard through LLM
> tool calls. This **supersedes** parts of [implementation.md](./implementation.md)
> §1 and §3.4 (see "What this overrides"). Design docs here are an iterating
> snapshot, not law — overwrite freely as the idea evolves.
>
> **Status:** architecture settled (this session). Tool *schemas* and build plans
> are the next session's job. Nothing built yet.

---

## The core idea: agents-as-tools

The **voice agent is an orchestrator**. The two specialist agents we're building
are **abstracted behind tool calls** — to the voice LLM they look like ordinary
tools (`tool_call → tool_result`), but each is actually a full agent with its own
model, system prompt, context, and Sentry span. This is the
orchestrator-workers / "agents-as-tools" pattern.

Why: the voice brain's latency-sensitive context stays tiny (just tool schemas);
the messy structuring/diagramming reasoning is encapsulated in workers that can
run bigger models (Opus/Sonnet) with rich prompts; each worker is swappable and
independently observable.

---

## Topology

```
speech ─▶ Flux STT ─▶ utterance stream
                          │
                          ├─▶ [Topic-Boundary Detector]  ← cheap/fast, owns the "when"
                          │        emits "topic sealed" ─┐
                          │                              ▼
                          │                   ┌──────────────────────┐
                          │   wakes only at   │  Voice Orchestrator   │ ─▶ talk-back (TTS)
                          └──────boundary────▶│  (judgment + calls)   │
                                              └───────────┬──────────┘
                                                          │ tool calls (dispatch-and-forget)
                                            ┌─────────────┴─────────────┐
                                            ▼                           ▼
                                     Structuring Agent            Spawner Agent
                                            └─────────────┬─────────────┘
                                                          ▼  board ops via existing bridge
                                                    Whiteboard
```

Transport is unchanged: workers POST `{action, payload}` to
`http://localhost:8081/send` → `mock-server.js` broadcasts over `ws://localhost:8080`
→ `commandQueue.ts` executes. The command queue is already a single serialized
writer (it doubles as the "Canvas Writer").

---

## Settled decisions

1. **Voice orchestrator owns the tools.** Not a separate "board agent" and not an
   independent transcript observer. The orchestrator decides which worker(s) to
   call.

2. **Dispatch-and-forget.** The orchestrator fires a worker tool, gets back a
   cheap ack (`{"status":"working"}`), and keeps talking. Workers run in the
   background and write to the board on their own timeline. This is what
   preserves "voice stays fast" — board path and speech path never block each
   other. Trade-off accepted: the orchestrator can't *see* exactly what a worker
   drew, so it can't reference specific drawn content verbatim in speech.

3. **Pedagogical judgment lives in the voice channel (orchestrator).** "Is there
   a question?", "did they get it wrong?", "is there a gap?" — the same brain
   that has to *speak* the clarifying question makes the judgment. No separate
   judgment agent.

4. **Topic boundary is detected by a dedicated cheap detector that *wakes* the
   orchestrator.** A small/fast model (or heuristic) watches the utterance stream
   and emits a single "topic sealed" signal; that signal is the only thing that
   wakes the expensive orchestrator. Keeps the orchestrator off the per-utterance
   hot path and makes the "when" logic an explicit, ownable, tunable component.
   The detector owns the *trigger*; the orchestrator owns the *judgment* and the
   *calls*.

5. **Two distinct tool surfaces (recommended; inner layer confirmed, outer layer
   has one open question — see below):**
   - **Outer surface — what the orchestrator sees:** a tiny coarse vocabulary,
     ~one tool per worker (`structure_topic(...)`, `spawn_artifacts(...)`). The
     orchestrator never thinks about node ids, positions, or
     mindmap-vs-flowchart.
   - **Inner surface — what the workers use:** the 15 `commandQueue` actions
     (`addMarkdown`, `addNote`, `addExplanation`, `appendToExplanation`,
     `addMindMap`, `addMindMapNode`, `addFlowchart`, `addFlowNode`,
     `connectNodes`, `updateNode`, `removeNode`, `requestImage`, `resolveImage`,
     `highlightNode`, `clearBoard`). The Structuring Agent picks the shape
     internally. `commandQueue.ts` is the source of truth for each payload.

---

## Open questions (start the next session here)

- **Does the orchestrator get any *direct* board primitives, or is it purely the
  coarse agent-tools?** Two candidates for direct access:
  - `highlight_node` — to pulse something on the board *while speaking* ("look at
    this…"), tightly coupled to speech and awkward to route through a worker.
  - the **live verbatim feed** (implementation.md §1.1 "ungated, verbatim nodes
    appear as you talk") — if it still exists, *something* writes to the board
    continuously, outside the topic-boundary worker path. Decide whether this
    survives at all.
- **What exactly does the orchestrator pass to a worker tool?** The sealed
  topic's raw transcript inline, or a topic id the worker resolves?
- **Where does the sealed raw transcript live** so a worker can read it (in-memory
  on the agent process, Supabase, passed inline)?
- **Tool-calling API shape:** native OpenAI-style `tools`/`tool_calls` on the
  orchestrator's endpoint vs pipecat function-calling. (Workers are separate
  Claude agents, likely Anthropic SDK / a small agent loop.)
- **Spatial concurrency** between Structuring (main region) and Spawner (margin) —
  implementation.md §1.4. Both POST to the same serialized queue; confirm whether
  the queue's serialization is enough or regions need reserving.

---

## What this overrides in implementation.md

- **§3.4 / decision #18** ("pulse reduced to STT/TTS transport; per-turn LLM
  removed from the speaking path") is **reversed**: the voice agent's LLM is back
  in the loop *as the orchestrator brain*. It is still mostly silent (acts at
  topic boundaries), but it is no longer a dumb transport.
- **§1.1 Inference Layer** is **dissolved as a standalone router.** Its two jobs
  split: routing ("which agents wake") becomes the orchestrator's tool-choice;
  the pedagogical judgment moves into the orchestrator (decision 3 above). The
  *trigger* half (topic-boundary "fires at a boundary, not per-chunk") survives
  as the dedicated boundary detector (decision 4).
- **§1.2 / §1.3 Structuring + Spawner agents** are retained, now reached as the
  orchestrator's coarse agent-tools rather than woken by a separate Inference
  Layer.
```
