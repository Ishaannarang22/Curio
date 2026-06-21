// Board Redis sync — server-only route. REDIS_URL is never exposed to the client.
// Keys match the M1 contract: board:{session}:block:{id}, board:{session}:index
export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import Redis from 'ioredis'

// ─── Singleton ioredis client (lazy, one instance per Node process) ───────────
let _redis: Redis | null = null

function getRedis(): Redis {
  if (_redis) return _redis
  const url = process.env.REDIS_URL
  if (!url) {
    // Still construct a client — it will fail at connect time and be handled below.
    _redis = new Redis({ lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  } else {
    _redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
  }
  _redis.on('error', (err) => {
    // Log the error class but never the URL (which may contain credentials).
    console.error('[board/route] Redis error:', err.message)
  })
  return _redis
}

// ─── Key helpers (must match M1 schema) ───────────────────────────────────────
const blockKey = (session: string, id: string) => `board:${session}:block:${id}`
const indexKey = (session: string) => `board:${session}:index`

// ─── Types ─────────────────────────────────────────────────────────────────────
interface BBox { x: number; y: number; w: number; h: number }
interface BlockRecord {
  id: string
  topicId?: string
  type?: string
  title?: string
  content?: string
  bbox?: BBox
  shapeIds?: string[]
  updatedAt?: string
}
interface GeometryUpdate { id: string; bbox: BBox }

// ─── Validation helpers ────────────────────────────────────────────────────────

// Maximum number of geometry updates accepted in a single batched POST.
// Prevents a single request from spawning an unbounded number of Redis R-M-W ops.
const MAX_UPDATES_PER_REQUEST = 200

function isValidSession(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[\w\-:.]+$/.test(s)
}

function isValidId(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[\w\-:.]+$/.test(s)
}

function isValidBBox(b: unknown): b is BBox {
  if (!b || typeof b !== 'object') return false
  const { x, y, w, h } = b as Record<string, unknown>
  return [x, y, w, h].every((v) => typeof v === 'number' && isFinite(v))
}

// ─── POST /api/board ──────────────────────────────────────────────────────────
// Single update:  { session, id, bbox:{x,y,w,h} }
// Batched update: { session, updates:[{id, bbox}] }
// Writes geometry back to Redis (read-modify-write to preserve all other fields).
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const { session } = body
  if (!isValidSession(session)) {
    return NextResponse.json({ error: 'invalid session' }, { status: 400 })
  }

  // Normalise single-update into the batched form.
  let updates: GeometryUpdate[]
  if (Array.isArray(body.updates)) {
    updates = body.updates as GeometryUpdate[]
  } else if (body.id !== undefined && body.bbox !== undefined) {
    updates = [{ id: body.id as string, bbox: body.bbox as BBox }]
  } else {
    return NextResponse.json({ error: 'missing id/bbox or updates array' }, { status: 400 })
  }

  // Cap batch size to prevent a single request from flooding Redis.
  if (updates.length > MAX_UPDATES_PER_REQUEST) {
    return NextResponse.json({ error: 'too many updates' }, { status: 400 })
  }

  // Validate each update entry.
  // Note: error messages deliberately omit the submitted value to avoid reflecting
  // attacker-controlled strings back in the response.
  for (const u of updates) {
    if (!isValidId(u.id)) {
      return NextResponse.json({ error: 'invalid id in updates' }, { status: 400 })
    }
    if (!isValidBBox(u.bbox)) {
      return NextResponse.json({ error: 'invalid bbox in updates' }, { status: 400 })
    }
  }

  try {
    const redis = getRedis()
    // Process each update: read-modify-write to preserve all existing block fields.
    await Promise.all(
      updates.map(async ({ id, bbox }) => {
        const key = blockKey(session as string, id)
        const existing = await redis.get(key)
        let record: BlockRecord = existing ? (JSON.parse(existing) as BlockRecord) : { id }
        record = {
          ...record,
          bbox,
          updatedAt: new Date().toISOString(),
        }
        await redis.set(key, JSON.stringify(record))
        // Ensure the id is in the session index (idempotent).
        await redis.sadd(indexKey(session as string), id)
      }),
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    // Never leak the Redis URL or stack; return a safe 503.
    console.error('[board/route] POST failed:', (err as Error).message)
    return NextResponse.json({ error: 'storage unavailable' }, { status: 503 })
  }
}

// ─── GET /api/board?session= ──────────────────────────────────────────────────
// Returns { blocks: BlockRecord[] } for restore-on-mount.
// On any Redis failure returns { blocks: [] } (200) so the board still loads.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const session = searchParams.get('session')

  if (!isValidSession(session)) {
    return NextResponse.json({ error: 'invalid session' }, { status: 400 })
  }

  try {
    const redis = getRedis()
    const ids = await redis.smembers(indexKey(session))
    if (ids.length === 0) {
      return NextResponse.json({ blocks: [] })
    }

    // Fetch all block records in one pipeline pass.
    const pipeline = redis.pipeline()
    for (const id of ids) {
      pipeline.get(blockKey(session, id))
    }
    const results = await pipeline.exec()
    if (!results) return NextResponse.json({ blocks: [] })

    const blocks: BlockRecord[] = []
    for (const [err, raw] of results) {
      if (err || !raw) continue
      try {
        blocks.push(JSON.parse(raw as string) as BlockRecord)
      } catch {
        // Corrupt entry — skip silently.
      }
    }

    return NextResponse.json({ blocks })
  } catch (err) {
    // Return empty snapshot so the board still loads; don't expose details.
    console.error('[board/route] GET failed:', (err as Error).message)
    return NextResponse.json({ blocks: [] })
  }
}
