/**
 * GET /api/sentry-seed
 *
 * DEMO / SEED ROUTE — harmless. Fires 10 distinct, real-looking errors into
 * Sentry so the dashboard has representative issues to look at. Each error is
 * its own class + fingerprint, so Sentry groups them as 10 separate issues
 * (mirroring the real Curio stack: voice, board, persistence, brain).
 *
 *   GET /api/sentry-seed        → fire all 10
 *   GET /api/sentry-seed?n=3    → fire only seed #3
 *
 * Nothing here touches real state — every error is caught and reported via
 * Sentry.captureException, never re-thrown past the handler. Safe to delete
 * once the dashboard is populated.
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'

// ─── Named error classes ──────────────────────────────────────────────────────
// Distinct names give each issue a distinct title in the Sentry issues list.
class BoardSnapshotError extends Error {
  constructor(m: string) { super(m); this.name = 'BoardSnapshotError' }
}
class RedisConnectionError extends Error {
  constructor(m: string) { super(m); this.name = 'RedisConnectionError' }
}
class SupabaseRLSError extends Error {
  constructor(m: string) { super(m); this.name = 'SupabaseRLSError' }
}
class DeepgramSocketError extends Error {
  constructor(m: string) { super(m); this.name = 'DeepgramSocketError' }
}
class CartesiaRateLimitError extends Error {
  constructor(m: string) { super(m); this.name = 'CartesiaRateLimitError' }
}
class DailyJoinTimeoutError extends Error {
  constructor(m: string) { super(m); this.name = 'DailyJoinTimeoutError' }
}
class DeepSeekAuthError extends Error {
  constructor(m: string) { super(m); this.name = 'DeepSeekAuthError' }
}
class TldrawShapeError extends Error {
  constructor(m: string) { super(m); this.name = 'TldrawShapeError' }
}
class ImageGenTimeoutError extends Error {
  constructor(m: string) { super(m); this.name = 'ImageGenTimeoutError' }
}

interface Seed {
  key: string
  level: Sentry.SeverityLevel
  tags: Record<string, string>
  extra: Record<string, unknown>
  make: () => Error
}

const SEEDS: Seed[] = [
  {
    key: 'board-snapshot-undefined',
    level: 'error',
    tags: { component: 'whiteboard', feature: 'snapshot', route: '/api/boards/[id]/snapshot' },
    extra: { boardId: 'brd_8f2a91', shapesLen: undefined },
    make: () =>
      new (class extends BoardSnapshotError {})(
        "Cannot read properties of undefined (reading 'shapes')",
      ),
  },
  {
    key: 'redis-econnrefused',
    level: 'error',
    tags: { component: 'board-state', feature: 'redis', upstream: 'redis.io' },
    extra: { host: 'voice-teeth-boundary-86720.db.redis.io', port: 19897, attempt: 4 },
    make: () =>
      new RedisConnectionError(
        'connect ECONNREFUSED 10.0.4.12:19897 — board state store unreachable',
      ),
  },
  {
    key: 'supabase-rls-board-nodes',
    level: 'error',
    tags: { component: 'persistence', feature: 'supabase', table: 'board_nodes' },
    extra: { code: '42501', boardId: 'brd_4c01de', nodeId: 'mm-root' },
    make: () =>
      new SupabaseRLSError(
        'new row violates row-level security policy for table "board_nodes"',
      ),
  },
  {
    key: 'deepgram-socket-1006',
    level: 'error',
    tags: { component: 'voice', feature: 'stt', vendor: 'deepgram' },
    extra: { closeCode: 1006, model: 'nova-3', sessionMs: 41200 },
    make: () =>
      new DeepgramSocketError(
        'WebSocket closed unexpectedly (1006) before final transcript received',
      ),
  },
  {
    key: 'cartesia-429',
    level: 'warning',
    tags: { component: 'voice', feature: 'tts', vendor: 'cartesia' },
    extra: { status: 429, retryAfterMs: 2000, voiceId: 'sonic-english' },
    make: () =>
      new CartesiaRateLimitError(
        'Cartesia TTS returned 429 Too Many Requests (rate limit exceeded)',
      ),
  },
  {
    key: 'daily-join-timeout',
    level: 'error',
    tags: { component: 'voice', feature: 'transport', vendor: 'daily' },
    extra: { room: 'curio-voice-abc123', timeoutMs: 15000 },
    make: () =>
      new DailyJoinTimeoutError(
        'Timed out joining Daily room after 15000ms (transport=websocket)',
      ),
  },
  {
    key: 'deepseek-401',
    level: 'error',
    tags: { component: 'board-brain', feature: 'llm', vendor: 'deepseek' },
    extra: { status: 401, model: 'deepseek-v4-flash', endpoint: '/v1/chat/completions' },
    make: () =>
      new DeepSeekAuthError(
        'DeepSeek API request failed: 401 Unauthorized (invalid or expired api key)',
      ),
  },
  {
    key: 'board-send-bad-json',
    level: 'warning',
    tags: { component: 'whiteboard', feature: 'transport', route: '/api/board/send' },
    extra: { contentType: 'application/json', byteLength: 312 },
    make: () =>
      new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"),
  },
  {
    key: 'tldraw-shape-not-found',
    level: 'error',
    tags: { component: 'whiteboard', feature: 'command-queue', action: 'updateNode' },
    extra: { shapeId: 'shape:flow-3', queueDepth: 7 },
    make: () =>
      new TldrawShapeError(
        'Editor.updateShape failed: shape with id "shape:flow-3" not found on the page',
      ),
  },
  {
    key: 'image-gen-timeout',
    level: 'error',
    tags: { component: 'whiteboard', feature: 'requestImage', vendor: 'image-gen' },
    extra: { prompt: 'mitochondria cross-section diagram', timeoutMs: 30000 },
    make: () =>
      new ImageGenTimeoutError(
        'Image generation timed out after 30000ms; node left in loading state',
      ),
  },
]

function fire(seed: Seed): string {
  return Sentry.withScope((scope) => {
    scope.setLevel(seed.level)
    scope.setTag('seed', 'true')
    for (const [k, v] of Object.entries(seed.tags)) scope.setTag(k, v)
    scope.setExtras(seed.extra)
    // Stable fingerprint so re-running this route folds into the same 10 issues
    // instead of creating duplicates each call.
    scope.setFingerprint(['curio-seed', seed.key])
    return Sentry.captureException(seed.make())
  })
}

export async function GET(req: NextRequest) {
  const nParam = req.nextUrl.searchParams.get('n')

  let fired: { key: string; eventId: string }[]
  if (nParam !== null) {
    const idx = Number(nParam) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= SEEDS.length) {
      return NextResponse.json(
        { error: `n must be 1..${SEEDS.length}` },
        { status: 400 },
      )
    }
    const seed = SEEDS[idx]
    fired = [{ key: seed.key, eventId: fire(seed) }]
  } else {
    fired = SEEDS.map((seed) => ({ key: seed.key, eventId: fire(seed) }))
  }

  // Ensure events ship before the function returns (serverless can freeze).
  await Sentry.flush(2000)

  return NextResponse.json({ ok: true, count: fired.length, fired })
}
