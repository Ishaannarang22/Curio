# Curio server — Redis-backed real-time board sync

A small, **agent-agnostic** backend that makes the whiteboard's state durable and
live-synced across clients. The frontend stops being the source of truth; Redis
does.

```
 agent / curl / simulate.ts
        │  POST /command/:sessionId   { action, payload }
        ▼
 ┌──────────────┐   HSET board:<id> / board:edges:<id>     ┌─────────┐
 │ board-state  │ ───────────────────────────────────────▶ │  Redis  │
 │   .ts        │   PUBLISH board:updates:<id>              │ (stack) │
 └──────────────┘                                            └────┬────┘
                                                  Pub/Sub (board:updates:*)
 ┌──────────────┐                                                 │
 │   relay.ts   │ ◀───────────────────────────────────────────────┘
 │  ws :8090    │   on connect → hydrate from getFullBoardState()
 └──────┬───────┘   then forward every published command live
        │  ws://localhost:8090/<sessionId>   { action, payload }
        ▼
   whiteboard frontend (commandQueue.ts → boardApi.ts)
```

- **Source of truth:** a Redis Hash per session (`board:<sessionId>`) for nodes,
  plus `board:edges:<sessionId>` for explicit connections. Settled state only, so
  a refresh hydrates cleanly (no replayed loading shimmers / highlight pulses).
- **Real-time:** Redis Pub/Sub channel `board:updates:<sessionId>`; the relay
  pattern-subscribes once and fans out in-process by session.
- **Wire format:** exactly the `{ action, payload }` the frontend already speaks
  (`addMindMapNode`, `addFlowNode`, `connectNodes`, `updateNode`, `requestImage`,
  `resolveImage`, `highlightNode`, `removeNode`, `clearBoard`).

## Files

| File | Role |
| --- | --- |
| `src/board-state.ts` | Read/write the Redis Hashes + publish updates; `applyCommand` maps the wire protocol to persistence; `getFullBoardState` builds the ordered hydration snapshot. |
| `src/relay.ts` | WS server (:8090) + Pub/Sub fan-out + hydration; also boots the command HTTP server. |
| `src/command-server.ts` | `POST /command/:sessionId` (the "fake agent" seam) + `GET /state/:sessionId` (debug). Express on :8091. |
| `src/simulate.ts` | Scripted demo sequence fired at the command server. |
| `src/types.ts` | `Command`, `NodeRecord`, `EdgeRecord`. |

## Prerequisites

- Node 18+ (uses global `fetch`)
- A Redis instance — either local Docker **or** Redis Cloud (no Docker). Pick one below.

## Get Redis running (choose one)

### Option A — Redis Cloud (no Docker)

1. Create a free database at <https://redis.io/try-free/> (free 30 MB tier; core
   Redis + Pub/Sub is all this server needs).
2. Open the database → **Connect** → copy the connection URL. It looks like
   `redis://default:<password>@<host>.redns.redis-cloud.com:<port>`
   (use `rediss://` if the database has TLS enabled).
3. Point the server at it:
   ```bash
   cd server
   cp .env.example .env
   # edit .env and paste your URL into REDIS_URL=
   ```

### Option B — local Docker

```bash
cd server
npm run redis:up        # redis/redis-stack-server on :6379 (no .env needed)
```

## Quick start

```bash
cd server
npm install

# Start the relay (WS :8090 + command HTTP :8091).
# On boot it prints "[relay] redis OK" once Redis is reachable.
npm run relay:dev
```

**Frontend wiring (already applied).** The relay runs on **8090** and leaves the
existing `:8080` source untouched. `components/whiteboard/WhiteboardApp.tsx`
already opts in when the page URL carries a `?session=<id>` query param — it then
connects to `ws://localhost:8090/<id>` instead of `:8080`. Override the relay
base with `NEXT_PUBLIC_RELAY_URL` if it runs elsewhere. No edit needed; just open
the whiteboard with `?session=demo`.

Then, with the frontend open at `?session=demo`:

```bash
# 3. Fire the scripted sequence (defaults to session "demo")
npm run simulate          # or: npm run simulate -- mysession
```

Watch the board build live. Then **refresh the browser**: it reconnects, calls
`getFullBoardState`, and the board **reloads from Redis** instead of going blank —
minus the highlight pulse, which is ephemeral by design.

## Manual commands (instead of `simulate`)

```bash
curl -X POST localhost:8091/command/demo \
  -H 'content-type: application/json' \
  -d '{"action":"addMindMapNode","payload":{"id":"a","label":"Hello"}}'

# Inspect what a fresh client would hydrate with:
curl localhost:8091/state/demo
```

## npm scripts

| Script | Does |
| --- | --- |
| `npm run redis:up` / `redis:down` | Start / stop Redis Stack via docker compose |
| `npm run relay:dev` | Run the relay (tsx watch) |
| `npm run simulate [-- <sessionId>]` | Fire the scripted demo sequence |
| `npm run typecheck` | `tsc --noEmit` |

## How a real agent plugs in later

Nothing in `relay.ts` or the frontend needs to change. A real agent either:

- calls `applyCommand(sessionId, { action, payload })` / `upsertNode` / `removeNode`
  from `board-state.ts` directly (same process), or
- POSTs to `POST /command/:sessionId` (separate process) — exactly what
  `simulate.ts` does.

Either way the persist → publish → relay → WebSocket → frontend path is identical.

## Design notes / gotchas handled

- **Pub/Sub is fire-and-forget** → durability comes from the Hash + hydrate-on-
  connect. A briefly-disconnected client recovers full state on reconnect.
- **Snapshot/stream race** → a new client buffers live messages until its
  hydration snapshot is flushed, so it never sees a delta out of order.
- **Edges** are persisted separately so connections survive a refresh. Mind-map
  parent edges are recreated by replaying `addMindMapNode` with its `parentId`
  (which also preserves center-vs-branch styling); only explicit `connectNodes`
  edges live in the edges hash — no duplicate arrows.
- **Settled vs animated** → hydration emits settled state (a loaded image is
  re-sent as request+resolve so it ends on the final picture; `highlightNode` is
  never stored).
- **Dedicated subscriber connection** → ioredis can't mix subscribe mode with
  normal commands, so the relay's subscriber is separate from the read/write/
  publish client.
