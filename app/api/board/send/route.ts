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

const MAX_BODY_BYTES = 128 * 1024

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

  return NextResponse.json({ ok: true })
}
