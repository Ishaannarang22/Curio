// ─── Relay server ────────────────────────────────────────────────────────────
// Bridges Redis ⇄ browser:
//   • WebSocket server on :8090, one connection per session at ws://…/<sessionId>
//   • On connect: hydrate the client with the full current board (settled
//     commands) so a refresh reloads the board instead of going blank.
//   • Subscribes to board:updates:* and forwards each command to the matching
//     session's client(s) in real time.
//   • A new client buffers live messages until its hydration snapshot is flushed,
//     so it can never receive a delta before the snapshot it belongs after.
// Also boots the test/simulation HTTP endpoint (command-server) on :8091.
import { WebSocketServer, type WebSocket } from 'ws'
import { redis, createSubscriber } from './redis'
import { getFullBoardState } from './board-state'
import { createCommandApp } from './command-server'

// Fail loudly and helpfully if Redis isn't reachable (wrong/empty REDIS_URL).
redis.ping().then(
  () => console.log('[relay] redis OK'),
  (e) =>
    console.error(
      `[relay] cannot reach Redis (${e.message}). ` +
        'Set REDIS_URL in server/.env (Redis Cloud) or run `npm run redis:up` (Docker).',
    ),
)

const WS_PORT = 8090
const HTTP_PORT = 8091

type ClientConn = { ws: WebSocket; ready: boolean; buffer: string[] }

// sessionId -> connected clients
const sessions = new Map<string, Set<ClientConn>>()

function sessionIdFromUrl(url: string | undefined): string {
  const path = (url ?? '/').split('?')[0].replace(/^\/+/, '')
  return path.length ? decodeURIComponent(path) : 'default'
}

const wss = new WebSocketServer({ port: WS_PORT })

wss.on('connection', async (ws, req) => {
  const sessionId = sessionIdFromUrl(req.url)
  const conn: ClientConn = { ws, ready: false, buffer: [] }

  let set = sessions.get(sessionId)
  if (!set) {
    set = new Set()
    sessions.set(sessionId, set)
  }
  set.add(conn)
  console.log(`[relay] + client  session=${sessionId}  (${set.size} now)`)

  ws.on('close', () => {
    set!.delete(conn)
    if (set!.size === 0) sessions.delete(sessionId)
    console.log(`[relay] - client  session=${sessionId}`)
  })
  ws.on('error', () => {})

  // Hydrate: snapshot is read AFTER the conn is registered, so any command
  // published during the read lands in conn.buffer (ready=false) and is flushed
  // right after — preserving "snapshot, then deltas" order.
  try {
    const commands = await getFullBoardState(sessionId)
    for (const c of commands) ws.send(JSON.stringify(c))
    console.log(`[relay]   hydrated session=${sessionId} with ${commands.length} command(s)`)
  } catch (err) {
    console.error(`[relay] hydrate failed for ${sessionId}:`, err)
  }
  for (const m of conn.buffer) ws.send(m)
  conn.buffer = []
  conn.ready = true
})

// One shared subscriber for ALL sessions (pattern subscription), fanned out
// in-process by sessionId — far cheaper than a Redis connection per session.
const sub = createSubscriber()
sub.psubscribe('board:updates:*', (err) => {
  if (err) console.error('[relay] psubscribe failed:', err)
  else console.log('[relay] subscribed to board:updates:*')
})
sub.on('pmessage', (_pattern, ch, message) => {
  const sessionId = ch.slice('board:updates:'.length)
  const set = sessions.get(sessionId)
  if (!set) return
  for (const conn of set) {
    if (conn.ws.readyState !== conn.ws.OPEN) continue
    if (conn.ready) conn.ws.send(message)
    else conn.buffer.push(message) // not hydrated yet — keep order
  }
})

createCommandApp().listen(HTTP_PORT, () => {
  console.log(`[relay] command HTTP on http://localhost:${HTTP_PORT}`)
})
console.log(`[relay] websocket on ws://localhost:${WS_PORT}/<sessionId>`)
