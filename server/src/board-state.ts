// ─── Board state layer ───────────────────────────────────────────────────────
// Redis is the source of truth for the live whiteboard. Two structures per
// session:
//   board:<sessionId>        HASH  nodeId      -> NodeRecord (settled) JSON
//   board:edges:<sessionId>  HASH  "from:to"   -> EdgeRecord JSON
// Every mutation also PUBLISHes a { action, payload } command to
//   board:updates:<sessionId>
// which the relay forwards to connected clients for live animation.
//
// This module is AGENT-AGNOSTIC. A real agent later either calls applyCommand /
// upsertNode / removeNode directly, or hits the POST /command endpoint — nothing
// here knows or cares which.
import { redis } from './redis'
import type { Command, EdgeRecord, NodeRecord, Position } from './types'

const nodesKey = (s: string) => `board:${s}`
const edgesKey = (s: string) => `board:edges:${s}`
const channel = (s: string) => `board:updates:${s}`
const edgeField = (fromId: string, toId: string) => `${fromId}:${toId}`

// ─── Publish ─────────────────────────────────────────────────────────────────
async function publish(sessionId: string, command: Command): Promise<void> {
  await redis.publish(channel(sessionId), JSON.stringify(command))
}

// ─── Reads ───────────────────────────────────────────────────────────────────
export async function getNode(
  sessionId: string,
  nodeId: string,
): Promise<NodeRecord | null> {
  const raw = await redis.hget(nodesKey(sessionId), nodeId)
  return raw ? (JSON.parse(raw) as NodeRecord) : null
}

async function getEdges(sessionId: string): Promise<EdgeRecord[]> {
  const map = await redis.hgetall(edgesKey(sessionId))
  return Object.values(map).map((v) => JSON.parse(v) as EdgeRecord)
}

// ─── Writes ──────────────────────────────────────────────────────────────────
// Create or replace a node: persist the settled record AND publish the live
// creation command for connected clients. (updateNode / resolveImage take the
// dedicated paths below since they patch an existing node.)
export async function upsertNode(
  sessionId: string,
  nodeId: string,
  record: NodeRecord,
): Promise<void> {
  await redis.hset(nodesKey(sessionId), nodeId, JSON.stringify(record))
  for (const command of nodeToCommands(record, { settled: false })) {
    await publish(sessionId, command)
  }
}

export async function removeNode(sessionId: string, nodeId: string): Promise<void> {
  await redis.hdel(nodesKey(sessionId), nodeId)
  // Drop any edges that referenced this node so hydration never replays a
  // dangling connection.
  const map = await redis.hgetall(edgesKey(sessionId))
  const stale = Object.entries(map)
    .filter(([, v]) => {
      const e = JSON.parse(v) as EdgeRecord
      return e.fromId === nodeId || e.toId === nodeId
    })
    .map(([field]) => field)
  if (stale.length) await redis.hdel(edgesKey(sessionId), ...stale)
  await publish(sessionId, { action: 'removeNode', payload: { id: nodeId } })
}

async function connectNodes(
  sessionId: string,
  fromId: string,
  toId: string,
  label?: string,
): Promise<void> {
  const edge: EdgeRecord = { fromId, toId, ...(label ? { label } : {}) }
  await redis.hset(edgesKey(sessionId), edgeField(fromId, toId), JSON.stringify(edge))
  await publish(sessionId, {
    action: 'connectNodes',
    payload: { fromId, toId, ...(label ? { label } : {}) },
  })
}

async function patchNode(
  sessionId: string,
  nodeId: string,
  patch: Partial<NodeRecord>,
): Promise<NodeRecord | null> {
  const existing = await getNode(sessionId, nodeId)
  if (!existing) return null
  const updated = { ...existing, ...patch }
  await redis.hset(nodesKey(sessionId), nodeId, JSON.stringify(updated))
  return updated
}

export async function clearBoard(sessionId: string): Promise<void> {
  await redis.del(nodesKey(sessionId), edgesKey(sessionId))
  await publish(sessionId, { action: 'clearBoard', payload: {} })
}

// ─── Command dispatch ────────────────────────────────────────────────────────
// Translate an incoming { action, payload } (from POST /command or an agent)
// into the right state mutation. This is the one place that maps the wire
// protocol to persistence; keep it the single source of that mapping.
export async function applyCommand(sessionId: string, cmd: Command): Promise<void> {
  const p = cmd.payload ?? {}
  switch (cmd.action) {
    case 'addMindMapNode':
      await upsertNode(sessionId, str(p.id), {
        id: str(p.id),
        kind: 'mindMap',
        label: str(p.label),
        parentId: optStr(p.parentId),
        position: optPos(p.position),
      })
      break

    case 'addFlowNode':
      await upsertNode(sessionId, str(p.id), {
        id: str(p.id),
        kind: 'flow',
        label: str(p.label),
        subtitle: optStr(p.subtitle),
        position: optPos(p.position),
      })
      break

    case 'requestImage':
      await upsertNode(sessionId, str(p.id), {
        id: str(p.id),
        kind: 'image',
        prompt: str(p.prompt),
        position: optPos(p.position),
        status: 'loading',
      })
      break

    case 'resolveImage': {
      const updated = await patchNode(sessionId, str(p.id), {
        url: str(p.url),
        status: 'loaded',
      })
      // Publish even if the node is unknown — the live client may still have it.
      await publish(sessionId, {
        action: 'resolveImage',
        payload: { id: str(p.id), url: str(p.url) },
      })
      if (!updated) console.warn(`[board] resolveImage for unknown node ${str(p.id)}`)
      break
    }

    case 'updateNode': {
      const updated = await patchNode(sessionId, str(p.id), { label: str(p.newLabel) })
      await publish(sessionId, {
        action: 'updateNode',
        payload: { id: str(p.id), newLabel: str(p.newLabel) },
      })
      if (!updated) console.warn(`[board] updateNode for unknown node ${str(p.id)}`)
      break
    }

    case 'connectNodes':
      await connectNodes(sessionId, str(p.fromId), str(p.toId), optStr(p.label))
      break

    case 'removeNode':
      await removeNode(sessionId, str(p.id))
      break

    case 'highlightNode':
      // Ephemeral: a transient pulse. Publish for the live client, never store
      // (so a refreshed client doesn't replay stale highlights).
      await publish(sessionId, { action: 'highlightNode', payload: { id: str(p.id) } })
      break

    case 'clearBoard':
      await clearBoard(sessionId)
      break

    default:
      // Unknown/unmodeled action (e.g. addNote, addMarkdown): forward live so
      // nothing breaks, but it won't survive a refresh until it's modeled here.
      console.warn(`[board] passthrough (not persisted): ${cmd.action}`)
      await publish(sessionId, cmd)
  }
}

// ─── Hydration ───────────────────────────────────────────────────────────────
// The full current board as an ordered list of SETTLED commands, ready to be
// sent to a freshly-connected client so it lands on the live board instead of
// blank. Order matters: parents before children (addMindMapNode looks up its
// parent), all nodes before edges (connectNodes looks up both endpoints).
export async function getFullBoardState(sessionId: string): Promise<Command[]> {
  const map = await redis.hgetall(nodesKey(sessionId))
  const nodes = Object.values(map).map((v) => JSON.parse(v) as NodeRecord)
  const edges = await getEdges(sessionId)

  const commands: Command[] = []
  for (const node of orderByParent(nodes)) {
    commands.push(...nodeToCommands(node, { settled: true }))
  }
  for (const e of edges) {
    commands.push({
      action: 'connectNodes',
      payload: { fromId: e.fromId, toId: e.toId, ...(e.label ? { label: e.label } : {}) },
    })
  }
  return commands
}

// Emit roots first, then any node whose parent has already been emitted
// (a simple topological pass; leftovers from cycles/missing parents are flushed
// at the end so nothing is dropped).
function orderByParent(nodes: NodeRecord[]): NodeRecord[] {
  const byId = new Set(nodes.map((n) => n.id))
  const emitted = new Set<string>()
  const out: NodeRecord[] = []
  const pending = [...nodes]
  let progressed = true
  while (pending.length && progressed) {
    progressed = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const n = pending[i]
      const parentReady = !n.parentId || emitted.has(n.parentId) || !byId.has(n.parentId)
      if (parentReady) {
        out.push(n)
        emitted.add(n.id)
        pending.splice(i, 1)
        progressed = true
      }
    }
  }
  return [...out, ...pending]
}

// A node's command(s). For a loaded image, `settled` mode emits requestImage +
// resolveImage so the hydrated client ends on the final picture; live mode just
// emits the creation command (status changes arrive as their own commands).
function nodeToCommands(node: NodeRecord, opts: { settled: boolean }): Command[] {
  switch (node.kind) {
    case 'mindMap':
      return [
        {
          action: 'addMindMapNode',
          payload: {
            id: node.id,
            label: node.label,
            ...(node.parentId ? { parentId: node.parentId } : {}),
            ...(node.position ? { position: node.position } : {}),
          },
        },
      ]
    case 'flow':
      return [
        {
          action: 'addFlowNode',
          payload: {
            id: node.id,
            label: node.label,
            ...(node.subtitle ? { subtitle: node.subtitle } : {}),
            ...(node.position ? { position: node.position } : {}),
          },
        },
      ]
    case 'image': {
      const create: Command = {
        action: 'requestImage',
        payload: {
          id: node.id,
          prompt: node.prompt,
          ...(node.position ? { position: node.position } : {}),
        },
      }
      if (opts.settled && node.status === 'loaded' && node.url) {
        return [create, { action: 'resolveImage', payload: { id: node.id, url: node.url } }]
      }
      return [create]
    }
  }
}

// ─── tiny payload coercion helpers ───────────────────────────────────────────
function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '')
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function optPos(v: unknown): Position | undefined {
  if (v && typeof v === 'object' && 'x' in v && 'y' in v) {
    const p = v as { x: unknown; y: unknown }
    if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
  }
  return undefined
}
