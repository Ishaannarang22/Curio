# Voice → Whiteboard Harness — Design Spec

**Date:** 2026-06-20
**Status:** design approved (this session); implementation plan is the next step.
**Supersedes:** [agent-tool-architecture.md](../../../agent-tool-architecture.md)
Decision #1 (we use a **separate board brain**, not speaker-owns-tools) and its
Structuring/Spawner worker split (collapsed to one brain for v1).
**Companion doc:** [tools.md](../../../tools.md) — the tool contract.

---

## 1. Goal

Turn a student's spoken brain-dump into a structured, living whiteboard in real
time. As they speak, words appear immediately (live transcription); when they
finish a thought, that raw text is **replaced** in place by a cleanly formatted
artifact (notes/table, or a flowchart/mind-map/image) with semantic
understanding. Voice must never be slowed by the board work.

## 2. Core principles (settled)

1. **Dual channel.** The speaking agent (`bot.py`) is untouched — it only talks.
   A separate **board brain** observes the same transcript stream and drives the
   board in parallel. Speech and tool use happen at the same time; the speech
   path never blocks on the board.
2. **Live transcription (Phase 1).** Always on, no LLM, instant. Partial
   transcripts stream into a live block on the board as the student speaks.
3. **End-of-turn replacement (Phase 2).** On Flux's semantic EndOfTurn, the raw
   live text is replaced by the formatted artifact via an LLM tool-calling pass.
4. **Topic-end consolidation (Phase 3).** When a topic seals, **collapse all of
   its scattered pieces into one clean, legible artifact** — a single
   flowchart / graph / mind-map / Markdown block — and remove the leftover
   fragments. During capture a topic accumulates bits and pieces (a note, a
   half-list, a stray block); Phase 3 synthesizes them into the clearest single
   representation so the board reads as finished sections, not scattered scraps.
5. **Topic continuity via Redis.** The board brain reads the current board from
   Redis to decide *continue an existing block* vs *start a new one*. The
   continue-vs-new decision **doubles as topic-end detection**: deciding "new
   topic" means the previous one just sealed → trigger its consolidation. An idle
   timeout seals the final/trailing topic. No separate topic-boundary detector in
   v1 (Flux provides turn boundaries; the brain provides topic boundaries).
6. **Agent-side only (mostly).** Reuses the existing bridge and board shape
   vocabulary. The only board/Next-side change is the Redis write-back + restore.

## 3. Architecture

```
Flux STT ─┬─▶ speaking agent: LLM → Cartesia TTS            [unchanged — talks]
          │
          └─▶ Board brain (BoardWriter v2)                  [parallel, non-blocking]
                ├─ Phase 1: InterimTranscriptionFrame → live raw block   (no LLM)
                ├─ Phase 2: TranscriptionFrame (EndOfTurn) → per-turn replacement
                │      → LLM (Sonnet; GLM-5 fallback) + tools.md surface
                │      → tool_calls → Executor
                └─ Phase 3: topic seal (new-topic decision OR idle timeout)
                       → consolidate the topic's scattered pieces into ONE
                         artifact + remove fragments
                       → tool_calls → Executor
                                 │
                       POST :8081/send → ws :8080 → commandQueue.ts → tldraw
                                 │
                                Redis  (board state — two-way, persisted)
```

The board brain is an evolution of the existing `agent/board_writer.py`
`BoardWriter` pass-through `FrameProcessor`. It already: forwards every frame
untouched, fires work as `asyncio.create_task` (non-blocking), serializes with an
`asyncio.Lock`, and swallows all errors away from the speech path. v2 keeps all of
that and adds the three phases + tool-calling + Redis.

## 4. Components

### 4.1 Phase 1 — Live ASR
- Observes `InterimTranscriptionFrame`s (already bridged from Flux "Update"
  events in `bot.py`).
- Throttled (coalesce rapid updates, ~10–15/s max) to avoid spamming the bridge.
- Writes raw text to a single live scratch block: `addMarkdown` with a fixed id
  (`live`), updating in place as words arrive.
- No LLM, no Redis write of content (it's transient); position is tracked so
  Phase 2 knows where the live block sits.

### 4.2 Phase 2 — Structuring (end-of-turn)
- Trigger: final `TranscriptionFrame` (Flux semantic EndOfTurn).
- Builds one chat-completions call:
  - **system prompt:** the board brain's job (clean dictation, choose the right
    artifact, continue-vs-new rules, never invent facts).
  - **injected board state** (from Redis): `[{id, type, title, summary,
    bbox:{x,y,w,h}}]`.
  - **user content:** the turn's final transcript.
  - **tools:** the `tools.md` surface (native OpenAI `tools`, parallel calls).
- Model: a **fast, reliable tool-caller**, pinned via `CALLER_MODEL` and resolved
  **independently of the speaking agent** — it does *not* inherit the
  Gateway→NVIDIA→ZAI order (Nemotron is too weak at tool calls). v1 default:
  **GLM-5 turbo** (the fast variant) on the ZAI endpoint, chosen for low latency
  since this runs every turn; upgrades to **Claude Sonnet** when
  `AI_GATEWAY_API_KEY` is present.
- Returns `tool_calls`.
- Every block written is tagged in Redis with its **`topicId`** (the active topic
  thread), so a topic can own several blocks while it is being captured.
- **Topic-end signal:** if the pass mints a *new* `topicId` (vs reusing the active
  one), the previously-active topic is now sealed → enqueue a Phase 3
  consolidation for it before/alongside opening the new topic.

### 4.3 Phase 3 — Topic-end consolidation
- Trigger: a topic seals — either (a) Phase 2 decided "new topic," or (b) an idle
  timeout elapses with no continuation of the active topic (handles the trailing
  topic with no successor).
- **Gathers all blocks belonging to the closing topic** (Redis groups blocks by
  `topicId`) — every scattered piece, not just one block.
- Builds one chat-completions call scoped to that topic: all its pieces'
  content + a "**understand this topic, then choose the tool(s) that best fit its
  content**" system prompt + the `tools.md` tools. The model first comprehends the
  material, then **lets the content dictate the artifact type** — a process →
  `make_flowchart`, a comparison → a `write_notes` table, relationships/branches →
  `make_mindmap`, otherwise tightened `write_notes`.
- Returns `tool_calls` that produce **one consolidated artifact** for the topic and
  **`remove_block` the now-merged fragments** — so the topic ends as one legible
  block, not scattered scraps. The consolidated artifact reuses a stable per-topic
  id (idempotent on re-seal).
- Runs under the same lock, fire-and-forget; failure leaves the per-turn pieces
  intact (consolidation is an enhancement, never a regression — never deletes a
  fragment until its replacement is written).

### 4.4 Executor (tool_call → board + Redis)
For each `tool_call`, in emitted order:
1. **Resolve placement.** If Redis has a real position for this `id`, reuse it
   (update). Else compute an open `{x,y}` honoring any `anchor` hint.
2. **Replacement / morph-swap** for the live block on the first write of a turn:
   - artifact is **text/notes/table** → the `live` block becomes the topic block
     **in place** (content replaced, re-keyed `live` → `<id>`), so it visually
     morphs from raw to formatted in the same spot.
   - artifact is a **flowchart / mind-map / image** → remove the `live` block and
     create the typed shape in that region (swap).
   - **continuation** of an existing topic → fold the cleaned text into the
     existing `<id>` block (update in place); clear `live`.
3. **POST** `{action, payload}` to the bridge, translating the intent-level tool
   params into the `commandQueue` action's payload.
4. **Upsert Redis** `{id, type, title, content, bbox, updatedAt}`.
5. A fresh `live` block is prepared for the next turn.
- Serialized by the existing `asyncio.Lock` (read-after-write across turns).

### 4.5 Redis board model (two-way, persisted)
- Per shape: `board:{session}:{id}` → `{id, topicId, type, title, content,
  bbox:{x,y,w,h}, updatedAt}`; membership in `board:{session}:index`.
- **Topic grouping:** `board:{session}:topic:{topicId}` → set of block ids in that
  topic. This is what Phase 3 reads to gather every scattered piece of a sealed
  topic before consolidating; the consolidated artifact replaces the set.
- **Agent writes intent** on each op (id, type, title, content, intended bbox).
- **Whiteboard writes back real geometry**: client-side layout (ELK/d3-force) and
  manual edits change positions, so `commandQueue.ts` reports each shape's real
  post-layout `{x,y,w,h}` back to Redis. This keeps placement accurate and lets
  the brain "see" what actually landed.
- **Persistence:** the `{session}` key namespaces a board; restore-on-mount
  rehydrates the board from Redis so a session survives reloads.

## 5. Tool surface

Per [tools.md](../../../tools.md): `write_notes`, `make_flowchart`,
`make_mindmap`, `add_image` (stubbed in v1), `highlight`, `remove_block`,
`clear_board`. Native OpenAI function-calling, parallel calls, **upsert-by-id**,
no pixel coordinates (harness places), board state injected not queried. The `id`
string is the single join key: model ↔ `commandQueue` idMap ↔ Redis key.

## 6. Error handling & non-blocking guarantees

- Phase 2 runs as a fire-and-forget task under the `asyncio.Lock`; **every
  failure (LLM, tool, Redis, bridge) is logged + sent to Sentry and never
  reaches the speech path** — the current `BoardWriter` already guarantees this.
- Bridge or Redis unavailable → board ops are skipped (and Phase 1 degrades to
  no-op); the voice pipeline runs fully.
- Malformed/invalid tool args → that single call is dropped; sibling calls in the
  same turn still execute.
- The speaking agent has no dependency on any of the above.

## 7. Testing strategy

- **Phase 1:** feed synthetic `InterimTranscriptionFrame`s → assert the `live`
  block receives throttled in-place updates.
- **Phase 2:** mock the LLM to return canned `tool_calls` → assert the correct
  bridge POSTs and Redis upserts, for both **new-topic** and **continuation**.
- **Phase 3:** a new-topic decision (and an idle timeout) each trigger exactly one
  consolidation scoped to the closing topic; given a topic with several fragment
  blocks, it produces **one** consolidated artifact and `remove_block`s the
  fragments (no orphans, no duplicates), chooses the artifact type from content,
  and is skipped/harmless on failure (fragments never deleted before the
  replacement is written).
- **Executor:** unit-test placement (open-space + anchor) and **idempotent
  upsert** (same id twice = update, never duplicate); morph (text) vs swap
  (shape) on first write of a turn.
- **Redis:** round-trip a board, restore it, assert geometry survives; write-back
  updates an existing key rather than duplicating.
- **End-to-end:** `npm run whiteboard:mock` + a scripted transcript → eyeball the
  board renders and replacements.

## 8. Scope

**In v1**
- Dual-channel board brain (evolve `BoardWriter`).
- Phase 1 live ASR; Phase 2 per-turn structuring with end-of-turn replacement;
  Phase 3 topic-end consolidation — collapse a topic's scattered pieces into one
  content-appropriate artifact (triggered by new-topic decision + idle timeout).
- The 7 `tools.md` tools; `add_image` stubbed.
- Two-way Redis board model + session persistence (incl. the board-side
  write-back + restore).

**Later (tracked, not built)**
- Real image generation behind `add_image`.
- Data charts (bar/line) as a new board shape.
- Research / external retrieval as an output type.
- Cheap topic-change detector (cost optimization for the continue-vs-new call).
- Speaker-side Redis read so the voice agent can pedagogically react to the board.

## 9. Open implementation details (resolve in the plan, not blockers)

- Exact live-block re-keying mechanism (`live` → `<id>`) on morph — whether to
  reuse the tldraw shape id or create-then-delete.
- Throttle/coalesce policy for Phase 1 updates.
- Redis client + connection config in the Python agent; where `{session}` comes
  from (reuse the `conversationId` from the session payload).
- Board-side Redis write-back transport (direct Redis client in the Next app vs a
  small endpoint the whiteboard calls).
- Phase 3 idle-timeout value for sealing the trailing topic (start ~6–10s of no
  continuation; tune by feel).
- Phase 3 picks the artifact *type* from content (notes → flowchart, etc.); this
  is intended. Open: how aggressively to collapse — always exactly one block per
  topic, or allow a topic to keep 2–3 genuinely distinct artifacts (e.g. a diagram
  + a summary) when forcing one would lose information.
