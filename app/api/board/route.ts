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
const MAX_REQUEST_BYTES = 128 * 1024
const MAX_BLOCKS_PER_RESPONSE = 500
const MAX_RECORD_BYTES = 128 * 1024
const MAX_ABS_COORDINATE = 1_000_000
const MAX_DIMENSION = 100_000

// Read-modify-write the BlockRecord's real geometry. If the block key does not
// exist yet (e.g. an agent-created shape whose tldraw id the browser is the first
// to report), create a minimal record { id, bbox, updatedAt } so the real
// dimensions are still persisted for the agent's placement logic to read.
const GEOMETRY_UPDATE_SCRIPT = `
local key = KEYS[1]
local existing = redis.call("GET", key)
local record
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and type(decoded) == "table" then
    record = decoded
  else
    record = {}
  end
else
  record = {}
end
record["id"] = record["id"] or ARGV[1]
record["bbox"] = {
  x = tonumber(ARGV[2]),
  y = tonumber(ARGV[3]),
  w = tonumber(ARGV[4]),
  h = tonumber(ARGV[5])
}
record["updatedAt"] = ARGV[6]
redis.call("SET", key, cjson.encode(record))
return 1
`

function isValidSession(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[\w\-:.]+$/.test(s)
}

function isValidId(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && /^[\w\-:.]+$/.test(s)
}

function isValidBBox(b: unknown): b is BBox {
  if (!b || typeof b !== 'object') return false
  const { x, y, w, h } = b as Record<string, unknown>
  return (
    [x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    Math.abs(x as number) <= MAX_ABS_COORDINATE &&
    Math.abs(y as number) <= MAX_ABS_COORDINATE &&
    (w as number) >= 0 &&
    (h as number) >= 0 &&
    (w as number) <= MAX_DIMENSION &&
    (h as number) <= MAX_DIMENSION
  )
}

function safeJson(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...init?.headers,
    },
  })
}

function hasValidWriteAuth(req: NextRequest): boolean {
  const token = process.env.BOARD_API_TOKEN
  if (token) {
    const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    return bearer === token || req.headers.get('x-board-api-token') === token
  }

  const origin = req.headers.get('origin')
  if (!origin) return true

  const expected = new URL(req.url).origin
  return origin === expected
}

async function readJsonBody(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return safeJson({ error: 'content-type must be application/json' }, { status: 415 })
  }

  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REQUEST_BYTES) {
    return safeJson({ error: 'request too large' }, { status: 413 })
  }

  const raw = await req.text()
  if (raw.length > MAX_REQUEST_BYTES) {
    return safeJson({ error: 'request too large' }, { status: 413 })
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return safeJson({ error: 'invalid JSON body' }, { status: 400 })
    }
    return parsed as Record<string, unknown>
  } catch {
    return safeJson({ error: 'invalid JSON' }, { status: 400 })
  }
}

function parseBlockRecord(raw: string): BlockRecord | null {
  if (raw.length > MAX_RECORD_BYTES) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as BlockRecord
    if (!isValidId(record.id)) return null
    if (record.bbox !== undefined && !isValidBBox(record.bbox)) return null
    return record
  } catch {
    return null
  }
}

// ─── POST /api/board ──────────────────────────────────────────────────────────
// Single update:  { session, id, bbox:{x,y,w,h} }
// Batched update: { session, updates:[{id, bbox}] }
// Writes geometry back to Redis (read-modify-write to preserve all other fields).
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!hasValidWriteAuth(req)) {
    return safeJson({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = await readJsonBody(req)
  if (parsed instanceof NextResponse) {
    return parsed
  }
  const body = parsed

  const { session } = body
  if (!isValidSession(session)) {
    return safeJson({ error: 'invalid session' }, { status: 400 })
  }

  // Normalise single-update into the batched form.
  let updates: GeometryUpdate[]
  if (Array.isArray(body.updates)) {
    updates = body.updates as GeometryUpdate[]
  } else if (body.id !== undefined && body.bbox !== undefined) {
    updates = [{ id: body.id as string, bbox: body.bbox as BBox }]
  } else {
    return safeJson({ error: 'missing id/bbox or updates array' }, { status: 400 })
  }

  // Cap batch size to prevent a single request from flooding Redis.
  if (updates.length === 0 || updates.length > MAX_UPDATES_PER_REQUEST) {
    return safeJson({ error: 'invalid update count' }, { status: 400 })
  }

  // Validate each update entry.
  // Note: error messages deliberately omit the submitted value to avoid reflecting
  // attacker-controlled strings back in the response.
  for (const u of updates) {
    if (!isValidId(u.id)) {
      return safeJson({ error: 'invalid id in updates' }, { status: 400 })
    }
    if (!isValidBBox(u.bbox)) {
      return safeJson({ error: 'invalid bbox in updates' }, { status: 400 })
    }
  }

  try {
    const redis = getRedis()
    // Process each update atomically to preserve all existing block fields.
    await Promise.all(
      updates.map(async ({ id, bbox }) => {
        const key = blockKey(session as string, id)
        const updated = await redis.eval(
          GEOMETRY_UPDATE_SCRIPT,
          1,
          key,
          id,
          String(bbox.x),
          String(bbox.y),
          String(bbox.w),
          String(bbox.h),
          new Date().toISOString(),
        )
        // Ensure the id is in the session index (idempotent).
        if (updated === 1) {
          await redis.sadd(indexKey(session as string), id)
        }
      }),
    )
    return safeJson({ ok: true })
  } catch (err) {
    // Never leak the Redis URL or stack; return a safe 503.
    console.error('[board/route] POST failed:', (err as Error).message)
    return safeJson({ error: 'storage unavailable' }, { status: 503 })
  }
}

// ─── GET /api/board?session= ──────────────────────────────────────────────────
// Returns { blocks: BlockRecord[] } for restore-on-mount.
// On any Redis failure returns { blocks: [] } (200) so the board still loads.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url)
  const session = searchParams.get('session')

  if (!isValidSession(session)) {
    return safeJson({ error: 'invalid session' }, { status: 400 })
  }

  try {
    const redis = getRedis()
    const ids = (await redis.smembers(indexKey(session)))
      .filter(isValidId)
      .slice(0, MAX_BLOCKS_PER_RESPONSE)
    if (ids.length === 0) {
      return safeJson({ blocks: [] })
    }

    // Fetch all block records in one pipeline pass.
    const pipeline = redis.pipeline()
    for (const id of ids) {
      pipeline.get(blockKey(session, id))
    }
    const results = await pipeline.exec()
    if (!results) return safeJson({ blocks: [] })

    const blocks: BlockRecord[] = []
    for (const [err, raw] of results) {
      if (err || !raw) continue
      const record = parseBlockRecord(raw as string)
      if (record) {
        blocks.push(record)
      } else {
        // Corrupt entry — skip silently.
      }
    }

    return safeJson({ blocks })
  } catch (err) {
    // Return empty snapshot so the board still loads; don't expose details.
    console.error('[board/route] GET failed:', (err as Error).message)
    return safeJson({ blocks: [] })
  }
}
