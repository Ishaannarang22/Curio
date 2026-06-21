# Handoff — spec the Structuring Agent

> Purpose: a fresh agent picks up here to **spec the Structuring Agent**. The
> upstream trigger (topic boundary detection) is **locked** — its full spec is
> below as the contract the Structuring Agent consumes. This doc is a working
> handoff, not a living doc; fold final decisions into `prd.md` /
> `implementation.md` as you go.

## Status — BUILT (2026-06-21)

The Structuring Agent is **specced and implemented**: `agent/structuring_agent.py`
(two-stage router → renderer; queue-drained off the hot path; shared `BoardState`;
direct-to-bridge; Sentry spans) wired into `bot.py` as the boundary processor's
`on_seal`. The 3 formats are real one-shot tools incl. the new `make_diagram`
(`board_tools.py` + `boardApi.ts`/`commandQueue.ts`); placement now estimates real
sizes to avoid overlap. Tests: `tests/test_structuring_agent.py`. Design forks below
resolved in the grill: output=direct-to-bridge; shape=two-stage; no-restructure=leave
raw; diagram=new composite; parent seal=always merge; model=Sonnet 4.6. **Still
deferred:** the Spawner Agent, a real Canvas Writer (§1.5), the refining UI animation,
geometry write-back, and voice-override of the chosen format.

## Original task (for reference)

Spec the **Structuring Agent** (implementation.md §1.2) — the first of the two
agents the architecture spawns (the other is the Spawner Agent). It is fired by
a topic **seal** and turns a sealed node's raw transcript into a structured
artifact on the canvas.

## Context: where this sits

Pipeline (implementation.md §1):

```
speech -> Voice Agent (Python, agent/bot.py) -> live verbatim nodes
            | transcript stream (Flux EndOfTurn)
            v
     Topic boundary classifier  <-- LOCKED (spec below)
            | on SEAL
            v
     Structuring Agent  +  Spawner Agent   (parallel, both read immutable raw)
            | propose ops
            v
     Canvas Writer (single serialized chokepoint) -> tldraw (forked)
```

Key existing files:
- `agent/bot.py` — Pipecat 1.3.0 voice pipeline (Flux STT, Cartesia TTS,
  OpenAI-compatible brain). Owns the EndOfTurn transcript stream.
- `agent/board_writer.py` — the **current prototype** board brain (three-phase:
  live ASR mirror, end-of-turn structuring, idle-timeout consolidation). It uses
  an **8s idle timer + LLM `topicId` minting**. **This is being overwritten** —
  the locked boundary spec replaces its Phase 2/3 trigger model. Reuse what's
  useful (BoardState/Redis, BridgePoster, tool schemas in `board_tools.py`).
- `agent/board_state.py`, `agent/board_tools.py` — Redis-backed board state +
  tool surface / bridge poster. Likely reused by the Structuring Agent.
- Whiteboard bridge transport (unchanged): agent POSTs `{action, payload}` ->
  `scripts/whiteboard-mock-server.mjs` (`npm run whiteboard:mock`) -> WS ->
  `components/whiteboard/lib/commandQueue.ts` (the tool surface) ->
  `boardApi.ts`.

## IMPLEMENTED — Topic boundary detection (the upstream contract)

> **Status update:** the boundary engine below is now **built and tested**, not just
> locked. Files: `agent/topic_tree.py` (pure tree + verdict semantics,
> `tests/test_topic_tree.py`), `agent/topic_classifier.py` (the cheap per-turn LLM
> classifier), `agent/topic_boundary.py` (`TopicBoundaryProcessor`, wired into
> `bot.py` in place of `BoardWriter`). **Your hook:** the processor fires each seal
> through `on_seal: (SealEvent) -> awaitable` (the *seal seam*), currently a logger.
> The Structuring Agent IS the real `on_seal`. `SealEvent` gives you
> `node_id, label, kind ("leaf"|"parent"), raw, reason` — `kind` tells you leaf
> (provisional, structure the node's own raw) vs parent (re-render the whole
> subtree's raw, decide 1-vs-N granularity). Read raw, emit ops, never mutate it.



A cheap **per-turn classifier** in the Python voice backend watches the Flux
`EndOfTurn` transcript stream and places each utterance in an implicit
**recursive topic tree**. It is the hook that fires the Structuring Agent.

- **Runs:** in-process in the Python pipeline (hot path), one call per finished
  utterance. Fast/cheap model (Haiku-class) — distinct from the heavier
  Structuring Agent.
- **Input each turn:** (1) topic **tree skeleton** = node ids + labels marking
  active/sibling/sealed nodes (labels only, no full text); (2) **full raw** of
  the active node; (3) the new utterance.
- **Verdict (rich tree-move from the LLM):**
  - `CONTINUE` — same node; append utterance to active raw.
  - `DESCEND(label)` — drill into a child; active node stays open (becomes parent).
  - `SIBLING(label)` — seal current leaf; open new sibling under same parent.
  - `ASCEND` — left the subtree; seal current leaf **and** cascade-seal any
    ancestor whose subtree is now fully left.
  - `RETURN(id)` — re-open a sealed node; new raw appends.
- **Sealing is semantic only — NO timers, NO voice gaps.** A node seals only
  when the student moves off it. **Trailing topic** is sealed on **session
  end / disconnect** (the only non-content trigger).
- **Attribution:** the utterance that triggers a boundary belongs to the
  **destination** node; the sealed node keeps only its own raw.
- **What a seal fires (THIS is the Structuring Agent's trigger):**
  - **Leaf seal** -> Structuring Agent on that leaf's raw -> provisional
    artifact (live feedback as the student goes).
  - **Parent seal** -> Structuring Agent on the **whole subtree's raw**; the LLM
    decides granularity (keep N child artifacts vs merge into one), overriding
    the provisional per-leaf views.
- **Re-open paths:**
  - `RETURN` (voice) -> node re-opens, raw appends, re-structures on next seal.
  - **Revert** (manual) -> student reverts a structured artifact back to its raw
    md, edits it, regenerates; edited md becomes the new raw source of truth.
- **Invariants:** raw per node = durable source of truth (decision #9); agents
  read **immutable raw only** (#14); structuring is regenerable/reversible
  (#8/#10).
- **Runtime decision:** everything (classifier + agents) runs in the **Python
  voice backend** (deploys to Render/Railway). board_writer already calls Claude
  via the Vercel AI Gateway and POSTs to the whiteboard bridge — extend that.
  Not final; if agents later split into a TS service, the seal->structure
  boundary is the clean HTTP seam.

## Open forks to grill next session (Structuring Agent spec)

Resolve these one at a time, each with a recommended answer (user steers hard,
one question at a time):

1. **Output contract** (user parked this — pick it up first): does the agent
   **propose ops to a single Canvas Writer** (implementation.md §1.5,
   recommended — prevents Structuring/Spawner spatial collisions) or **write the
   bridge directly** (board_writer.py today)?
2. **Tool surface / artifact types:** flowchart / mind map / diagram / cleaned
   text (prd.md §2), chosen by content shape; student can override by voice.
   Which tools, and the leaf-vs-parent (1-vs-N artifacts) granularity call.
3. **Model:** default to latest Claude for our agents (implementation.md tech
   stack: Opus 4.8 / Sonnet 4.6). Confirm Sonnet vs Opus for structuring.
4. **Provisional -> final replacement:** how the parent-seal re-render replaces
   provisional leaf artifacts (Canvas Writer erase/refine; both read raw so no
   dangling refs).
5. **Spatial regions / concurrency** with the Spawner Agent (decision #14:
   different spaces, both read immutable raw).
6. **Revert mechanism** wiring: structured artifact -> raw md -> edit ->
   regenerate (prd.md §1.5).
7. **Sentry agent spans:** `gen_ai.invoke_agent`, `curio.agent="structuring"`,
   `curio.topic_id`, token usage (implementation.md §4).

## Working agreement (from memory)

- Voice-first AI note app; **design phase** — settle design forks before code.
- **Grill one fork at a time**, each with a recommended answer. User steers hard
  and dislikes code written before the design is settled.
- **Don't scope-cut for the hackathon** — hackathon status only affects
  licensing, never product scope. (User chose the full recursive tree over flat.)
- **Docs are iterating** — overwrite design decisions freely as the idea evolves
  (board_writer.py's timer model is being overwritten — that's expected).
- Read the relevant doc before working: `idea.md` (why), `prd.md` (what),
  `implementation.md` (how). Next.js here has breaking changes vs training data —
  read `node_modules/next/dist/docs/` before app code (AGENTS.md).
