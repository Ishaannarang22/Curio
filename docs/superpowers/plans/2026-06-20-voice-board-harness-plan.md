# Voice → Board Harness — Implementation Plan

Companion to [the design spec](../specs/2026-06-20-voice-board-harness-design.md)
and [tools.md](../../../tools.md). This is the task breakdown + the **interface
contracts** that let tasks run in parallel without coordinating, and the wave
order that respects dependencies.

## Module map & file ownership (disjoint — enables parallelism)

| Module | Files (owned) | Depends on |
|---|---|---|
| **M1 Redis board state** | `agent/board_state.py` (+ `agent/tests/test_board_state.py`) | — (interface below) |
| **M2 Tools + executor** | `agent/board_tools.py` (+ `agent/tests/test_board_tools.py`) | M1 *interface* |
| **M3 Board brain** | `agent/board_writer.py` (rewrite), minimal `agent/bot.py` wiring | M1 + M2 |
| **M4 Board-side Redis sync** | `app/api/board/route.ts`, `components/whiteboard/lib/boardSync.ts`, small wiring in `components/whiteboard/lib/commandQueue.ts` + `WhiteboardApp.tsx` | Redis key schema (below) |
| **M5 QA** | `agent/tests/*` integration, run suite | M1–M3 |
| **M6 Security** | review + targeted fixes | M1–M4 |

Shared dependency files (`agent/pyproject.toml`, root `package.json`) are already
updated — **agents must not touch them**.

## Interface contracts (FROZEN — build to these)

### M1 `BoardState` (async, `redis.asyncio`)
```
BlockRecord = {id, topicId, type, title, content, bbox:{x,y,w,h},
               shapeIds:[...], updatedAt}

class BoardState(redis_url: str, session: str)
  await connect(); await aclose()
  await set_active_topic(topic_id) ; await get_active_topic() -> str|None
  await upsert_block(rec: BlockRecord)
  await get_block(id) -> BlockRecord|None
  await remove_block(id)
  await update_geometry(id, bbox)                # board write-back path
  await get_topic_blocks(topic_id) -> list[BlockRecord]
  await get_state_summary() -> list[dict]        # compact: {id,topicId,type,title,summary,bbox}
  await clear()
```
- **Keys** (the M4 contract too): `board:{session}:block:{id}` (JSON string),
  `board:{session}:index` (set of ids), `board:{session}:topic:{topicId}` (set of
  ids), `board:{session}:active_topic` (string).
- **Graceful:** any Redis failure is logged + swallowed (return None/empty/no-op),
  **never raised** — the board brain must survive Redis being down.
- Tests use `fakeredis.aioredis`.

### M2 `board_tools`
```
TOOL_SCHEMAS: list[dict]            # OpenAI `tools`, exactly the 7 in tools.md
class BridgePoster:                 # injected; httpx POST {action,payload} -> send_url; swallow errors
  await send(action: str, payload: dict)
async def execute_tool_call(tool_call, *, state: BoardState, bridge: BridgePoster,
                            active_topic: str, anchor_pos=None) -> dict
async def resolve_placement(state: BoardState, block_id: str, anchor: dict|None) -> {x,y}
```
- Maps each intent-level tool to `commandQueue` action(s) (see
  `components/whiteboard/lib/boardApi.ts` for payloads):
  `write_notes`→`addMarkdown`, `make_flowchart`→`addFlowchart`,
  `make_mindmap`→`addMindMap`, `add_image`→`requestImage` (stub: no resolve),
  `highlight`→`highlightNode`, `remove_block`→`removeNode`/delete children,
  `clear_board`→`clearBoard`.
- **Key wrinkle:** a logical block id (e.g. a flowchart) maps to *several* board
  shapes (one per step). Track those board shape ids in `BlockRecord.shapeIds` so
  update/remove works. The intent-level `id` is the join key; child shape ids live
  in state.
- Placement: model never sends pixels; compute an open `{x,y}` from existing bboxes
  (honor `anchor.near`/`dir`). Keep it simple (grid/row packing is fine).
- Pure/testable: inject a fake `BridgePoster` + `fakeredis` state in tests.

### Bridge & model config (already in env)
- Bridge POST: `WHITEBOARD_SEND_URL` (default `http://localhost:8081/send`).
- Board-brain model: resolve **independently** — prefer `AI_GATEWAY_API_KEY`
  (Sonnet) else `ZAI_*` (GLM-5 turbo via `CALLER_MODEL`); **must not** fall through
  to NVIDIA/Nemotron. `REDIS_URL` for state.

## M3 Board brain (`board_writer.py` rewrite) — behavior
Keep the existing non-blocking guarantees (pass-through `FrameProcessor`,
`asyncio.create_task`, `asyncio.Lock`, swallow-all-errors, Sentry). Add:
- **Phase 1 (live ASR):** observe `InterimTranscriptionFrame`, throttle/coalesce
  (~10–15/s), mirror raw text to the `live` block (`addMarkdown` id=`live`).
- **Phase 2 (end-of-turn):** on final `TranscriptionFrame`, one tool-calling LLM
  pass: system prompt + injected `get_state_summary()` + the turn text + `TOOL_SCHEMAS`
  → execute returned `tool_calls` (continue-vs-new via the id the model picks).
  Morph the `live` block into the chosen text block, or swap it for a shape.
  Tag written blocks with the active `topicId`. If the model opens a **new**
  `topicId`, enqueue Phase 3 for the prior topic.
- **Phase 3 (topic-end consolidation):** gather `get_topic_blocks(sealed)`, one LLM
  pass "understand the topic, choose the tool that fits its content" → produce ONE
  consolidated artifact (reuse a stable per-topic id) + `remove_block` the
  fragments (never delete a fragment before the replacement is written). Also fire
  on an **idle timeout** (~6–10s) for the trailing topic.
- All three phases serialized by the lock; every failure logged to Sentry, never
  reaches the speech path. Frames always forwarded.

## M4 Board-side Redis sync — behavior
Browser must NOT hold Redis creds. Server-side only:
- `app/api/board/route.ts` — `POST` geometry updates `{session, id, bbox}` →
  `state.update_geometry`; `GET ?session=` → board snapshot for restore. Uses
  `ioredis` with `REDIS_URL` (server env, never `NEXT_PUBLIC_*`). Same key schema
  as M1.
- `components/whiteboard/lib/boardSync.ts` — debounced client that POSTs real
  post-layout `{x,y,w,h}` for shapes (from tldraw) and fetches restore-on-mount.
- Wire: report geometry after `commandQueue` ops settle; rehydrate on
  `WhiteboardApp` mount. Keep it best-effort (failures are silent, board still works).

## Waves (commit after each)
- **Wave 1 (parallel):** M1, M2, M4 — disjoint files, build to frozen interfaces.
- **Wave 2:** M3 — integrates M1+M2 into the board brain.
- **Wave 3 (parallel):** M5 QA (full suite + integration with mock bridge +
  fakeredis; fix gaps) and M6 Security (secrets never client-side/committed, tool-arg
  validation, API-route input validation / SSRF / DoS, no secret logging).

## Acceptance per module
- M1: unit tests green (fakeredis) for upsert/get/remove/topic-grouping/summary/geometry/clear.
- M2: each tool maps to the right `{action,payload}`; placement non-overlapping;
  multi-shape blocks tracked + removable; tests with mock bridge.
- M3: phase tests with a mocked LLM (canned tool_calls) — continuation, new-topic
  (→ Phase 3), idle-timeout seal; non-blocking (speech frames always forwarded).
- M4: `next build` passes; API route round-trips geometry + restore; no Redis
  creds in client bundle.
- M5: `cd agent && uv run pytest` green; `npm run build` green.
- M6: written findings + fixes applied.

## Global conventions for all agents
- Match existing code style (see `board_writer.py`, `bot.py`, `boardApi.ts`).
- Never touch `pyproject.toml`/`package.json` (deps already added) or `.env.local`.
- When genuinely in doubt, make the simplest correct choice and leave a short
  comment noting the assumption; do not block.
