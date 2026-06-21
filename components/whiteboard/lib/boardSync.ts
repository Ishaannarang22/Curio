// boardSync.ts — client-side helper for the board ↔ Redis two-way sync.
// All Redis I/O happens via /api/board (server route); no credentials here.
// Every call is best-effort: errors are caught and ignored so the board
// remains fully functional when the sync route is unavailable.

interface BBox { x: number; y: number; w: number; h: number }
interface GeometryUpdate { id: string; bbox: BBox }

export interface BlockRecord {
  id: string
  topicId?: string
  type?: string
  title?: string
  content?: string
  bbox?: BBox
  shapeIds?: string[]
  updatedAt?: string
}

// ─── Debounced geometry reporter ──────────────────────────────────────────────
// Accumulates updates over DEBOUNCE_MS then flushes them in one batched POST.
const DEBOUNCE_MS = 500

let _session = 'default'
let _pending: Map<string, BBox> = new Map()
let _timer: ReturnType<typeof setTimeout> | null = null

/** Set the active session id (call once on mount). */
export function setSession(session: string): void {
  _session = session || 'default'
}

/**
 * Report real post-layout geometry for one or more shapes.
 * Calls are debounced: rapid updates within DEBOUNCE_MS are coalesced.
 * Best-effort — failures are caught and ignored.
 */
export function reportGeometry(
  updates: GeometryUpdate | GeometryUpdate[],
  session?: string,
): void {
  const sess = session ?? _session
  const arr = Array.isArray(updates) ? updates : [updates]
  for (const { id, bbox } of arr) {
    _pending.set(`${sess}::${id}`, bbox)
    // Store session on the entry so the flush knows which session each belongs to.
    // For simplicity (single-session board), we use the shared _session.
    void sess // used implicitly via _session
  }

  if (_timer) clearTimeout(_timer)
  _timer = setTimeout(() => {
    _timer = null
    flushGeometry(sess).catch(() => { /* best-effort */ })
  }, DEBOUNCE_MS)
}

async function flushGeometry(session: string): Promise<void> {
  if (_pending.size === 0) return
  // Snapshot and clear the pending map before the async call so new updates
  // that arrive during the fetch don't get swallowed.
  const snapshot = Array.from(_pending.entries()).map(([key, bbox]) => ({
    id: key.replace(`${session}::`, ''),
    bbox,
  }))
  _pending = new Map()

  try {
    const res = await fetch('/api/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, updates: snapshot }),
    })
    if (!res.ok) {
      console.warn('[boardSync] reportGeometry non-ok:', res.status)
    }
  } catch (err) {
    console.warn('[boardSync] reportGeometry failed (offline?):', (err as Error).message)
  }
}

// ─── Restore-on-mount ─────────────────────────────────────────────────────────
/**
 * Fetch the board snapshot from Redis via the server route.
 * Returns an empty array on any error (board still loads normally).
 */
export async function fetchBoard(session?: string): Promise<BlockRecord[]> {
  const sess = encodeURIComponent(session ?? _session)
  try {
    const res = await fetch(`/api/board?session=${sess}`, { cache: 'no-store' })
    if (!res.ok) {
      console.warn('[boardSync] fetchBoard non-ok:', res.status)
      return []
    }
    const data = (await res.json()) as { blocks?: BlockRecord[] }
    return data.blocks ?? []
  } catch (err) {
    console.warn('[boardSync] fetchBoard failed (offline?):', (err as Error).message)
    return []
  }
}
