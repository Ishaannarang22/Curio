/**
 * POST /api/board/send
 *
 * Receives a board command from the Python agent (or any caller) and broadcasts
 * it to all SSE subscribers for the given session.
 *
 * Body: { action: string, payload: Record<string, unknown>, session?: string }
 * Response: { ok: true }
 *
 * Transport: module-level in-memory registry of SSE ReadableStreamDefaultController
 * instances. Works correctly in `next dev` (single Node process). In a
 * multi-instance production deployment you would need a pub/sub layer (e.g.
 * Redis Pub/Sub), but for the Curio dev setup this is sufficient.
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { broadcast } from '../_registry'
import { createServiceClient } from '@/lib/supabase/admin'
import type { Json } from '@/lib/supabase/types'

const MAX_BODY_BYTES = 128 * 1024

// ─── Agent-write durable flush (service role, best-effort) ────────────────────
// The Python voice agent has no user cookie, so voice-only boards would never
// persist their structure without this. We mirror the persisted actions into
// board_nodes / board_edges via the service-role client (RLS-bypassing). The
// browser snapshot remains the richer truth; this keeps structure for boards
// edited entirely by voice. Throttled per session and fully fire-and-forget —
// a flush failure must NEVER affect the broadcast.

const FLUSH_THROTTLE_MS = 1000
const lastTouch = new Map<string, number>()

function pos(v: unknown): Json | null {
  if (
    v &&
    typeof v === 'object' &&
    Number.isFinite((v as { x?: unknown }).x) &&
    Number.isFinite((v as { y?: unknown }).y)
  ) {
    const p = v as { x: number; y: number }
    return { x: p.x, y: p.y } as Json
  }
  return null
}
function s(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

async function flushAgentWrite(
  session: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = createServiceClient()
  if (!supabase) return // service key absent — no-op, nothing crashes.

  // board id === session value.
  switch (action) {
    case 'addMindMapNode':
    case 'addFlowNode': {
      const node_id = s(payload.id)
      if (!node_id) return
      await supabase.from('board_nodes').upsert(
        {
          board_id: session,
          node_id,
          kind: action === 'addMindMapNode' ? 'mindMap' : 'flow',
          label: s(payload.label),
          subtitle: s(payload.subtitle),
          position: pos(payload.position),
        },
        { onConflict: 'board_id,node_id' },
      )
      break
    }
    case 'requestImage': {
      const node_id = s(payload.id)
      if (!node_id) return
      await supabase.from('board_nodes').upsert(
        {
          board_id: session,
          node_id,
          kind: 'image',
          label: s(payload.prompt),
          position: pos(payload.position),
          status: 'loading',
        },
        { onConflict: 'board_id,node_id' },
      )
      break
    }
    case 'resolveImage': {
      const node_id = s(payload.id)
      if (!node_id) return
      await supabase
        .from('board_nodes')
        .update({ url: s(payload.url), status: 'loaded' })
        .eq('board_id', session)
        .eq('node_id', node_id)
      break
    }
    case 'connectNodes': {
      const from_id = s(payload.fromId)
      const to_id = s(payload.toId)
      if (!from_id || !to_id) return
      await supabase
        .from('board_edges')
        .upsert(
          { board_id: session, from_id, to_id },
          { onConflict: 'board_id,from_id,to_id' },
        )
      break
    }
    default:
      return // not a persisted action — broadcast only.
  }

  // Bump the board's updated_at, throttled so a burst of node writes is cheap.
  const now = Date.now()
  if (now - (lastTouch.get(session) ?? 0) > FLUSH_THROTTLE_MS) {
    lastTouch.set(session, now)
    await supabase
      .from('boards')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session)
  }
}

// Matches the write-auth on /api/board (route.ts): when BOARD_API_TOKEN is set,
// require a matching Bearer / x-board-api-token header (the Python agent sends
// this); otherwise fall back to same-origin (the browser never POSTs here, but
// dev tools / curl from the same origin are allowed).
function hasValidWriteAuth(req: NextRequest): boolean {
  const token = process.env.BOARD_API_TOKEN
  if (token) {
    const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    return bearer === token || req.headers.get('x-board-api-token') === token
  }
  const origin = req.headers.get('origin')
  if (!origin) return true
  return origin === new URL(req.url).origin
}

function isValidSession(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[\w\-:.]+$/.test(s)
}

export async function POST(req: NextRequest) {
  if (!hasValidWriteAuth(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Size guard
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request too large' }, { status: 413 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  ) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
  }

  const raw = body as Record<string, unknown>
  const { action, payload, session } = raw

  if (typeof action !== 'string' || action.length === 0) {
    return NextResponse.json({ error: 'Missing or invalid "action"' }, { status: 400 })
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json({ error: 'Missing or invalid "payload"' }, { status: 400 })
  }

  const sessionKey = isValidSession(session) ? session : 'default'

  const sent = broadcast(sessionKey, { action, payload: payload as Record<string, unknown> })
  console.log(`[board/send] session=${sessionKey} action=${action} subscribers=${sent}`)

  // Durable agent-write flush — best-effort, never blocks/breaks the broadcast.
  try {
    await flushAgentWrite(sessionKey, action, payload as Record<string, unknown>)
  } catch (err) {
    console.warn('[board/send] durable flush failed (ignored):', (err as Error).message)
  }

  return NextResponse.json({ ok: true })
}
