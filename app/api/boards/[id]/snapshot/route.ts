/**
 * PUT /api/boards/[id]/snapshot
 *
 * Durable save of a board from the browser. Body:
 *   { snapshot: <tldraw snapshot>, nodes?: DerivedNode[], edges?: DerivedEdge[], title?: string }
 *
 * - Upserts `boards.snapshot` (and `updated_at`, optional `title`). RLS ensures
 *   the caller owns the board (a non-owner's UPDATE simply matches 0 rows).
 * - Replaces the derived `board_nodes` / `board_edges` rows for this board.
 *
 * Snapshot is the source of truth; derived rows are a queryable projection.
 * Returns 401 with no user, 404 if the board isn't owned by / visible to them.
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/types'

const MAX_TITLE_CHARS = 200
const MAX_ROWS = 2000

interface DerivedNodeInput {
  node_id: string
  kind: string
  label?: string | null
  subtitle?: string | null
  position?: { x: number; y: number } | null
  url?: string | null
  status?: string | null
}
interface DerivedEdgeInput {
  from_id: string
  to_id: string
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: boardId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 })
  }
  const raw = body as Record<string, unknown>

  if (raw.snapshot === undefined || raw.snapshot === null) {
    return NextResponse.json({ error: 'missing "snapshot"' }, { status: 400 })
  }

  // ── 1. Upsert the snapshot (truth). RLS gates ownership. ────────────────────
  const update: { snapshot: Json; updated_at: string; title?: string } = {
    snapshot: raw.snapshot as Json,
    updated_at: new Date().toISOString(),
  }
  const title = asString(raw.title)
  if (title) update.title = title.trim().slice(0, MAX_TITLE_CHARS)

  const { data: updated, error: updErr } = await supabase
    .from('boards')
    .update(update)
    .eq('id', boardId)
    .select('id')
    .maybeSingle()

  if (updErr) {
    console.error('[api/boards/snapshot] update error:', updErr.message)
    return NextResponse.json({ error: 'failed to save snapshot' }, { status: 500 })
  }
  if (!updated) {
    // No row updated → board doesn't exist or isn't owned by this user (RLS).
    return NextResponse.json({ error: 'board not found' }, { status: 404 })
  }

  // ── 2. Replace derived rows (best-effort projection of the snapshot). ───────
  const nodes = sanitizeNodes(raw.nodes)
  const edges = sanitizeEdges(raw.edges)

  // board_nodes: delete-then-insert keeps the table an exact mirror of the
  // current board (handles removed nodes for free).
  const { error: delNodesErr } = await supabase
    .from('board_nodes')
    .delete()
    .eq('board_id', boardId)
  if (delNodesErr) {
    console.warn('[api/boards/snapshot] delete nodes:', delNodesErr.message)
  }
  if (nodes.length > 0) {
    const { error: insNodesErr } = await supabase.from('board_nodes').insert(
      nodes.map((n) => ({
        board_id: boardId,
        node_id: n.node_id,
        kind: n.kind,
        label: n.label ?? null,
        subtitle: n.subtitle ?? null,
        position: (n.position ?? null) as Json,
        url: n.url ?? null,
        status: n.status ?? null,
      })),
    )
    if (insNodesErr) {
      console.warn('[api/boards/snapshot] insert nodes:', insNodesErr.message)
    }
  }

  const { error: delEdgesErr } = await supabase
    .from('board_edges')
    .delete()
    .eq('board_id', boardId)
  if (delEdgesErr) {
    console.warn('[api/boards/snapshot] delete edges:', delEdgesErr.message)
  }
  if (edges.length > 0) {
    const { error: insEdgesErr } = await supabase.from('board_edges').insert(
      edges.map((e) => ({ board_id: boardId, from_id: e.from_id, to_id: e.to_id })),
    )
    if (insEdgesErr) {
      console.warn('[api/boards/snapshot] insert edges:', insEdgesErr.message)
    }
  }

  return NextResponse.json({ ok: true })
}

function sanitizeNodes(v: unknown): DerivedNodeInput[] {
  if (!Array.isArray(v)) return []
  const out: DerivedNodeInput[] = []
  for (const item of v.slice(0, MAX_ROWS)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const node_id = asString(r.node_id)
    const kind = asString(r.kind)
    if (!node_id || !kind) continue
    let position: { x: number; y: number } | null = null
    if (
      r.position &&
      typeof r.position === 'object' &&
      Number.isFinite((r.position as { x?: unknown }).x) &&
      Number.isFinite((r.position as { y?: unknown }).y)
    ) {
      const p = r.position as { x: number; y: number }
      position = { x: p.x, y: p.y }
    }
    out.push({
      node_id,
      kind,
      label: asString(r.label),
      subtitle: asString(r.subtitle),
      position,
      url: asString(r.url),
      status: asString(r.status),
    })
  }
  // De-dupe by node_id (board_nodes has unique(board_id, node_id)).
  const seen = new Set<string>()
  return out.filter((n) => (seen.has(n.node_id) ? false : (seen.add(n.node_id), true)))
}

function sanitizeEdges(v: unknown): DerivedEdgeInput[] {
  if (!Array.isArray(v)) return []
  const out: DerivedEdgeInput[] = []
  const seen = new Set<string>()
  for (const item of v.slice(0, MAX_ROWS)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const from_id = asString(r.from_id)
    const to_id = asString(r.to_id)
    if (!from_id || !to_id) continue
    const key = `${from_id}::${to_id}`
    if (seen.has(key)) continue // unique(board_id, from_id, to_id)
    seen.add(key)
    out.push({ from_id, to_id })
  }
  return out
}
