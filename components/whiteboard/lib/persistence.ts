// persistence.ts — pure helpers for durable Supabase board persistence.
//
// Redis stays the fast LIVE cache (see boardSync.ts); Supabase is the durable
// source of truth. This module derives the `board_nodes` / `board_edges` rows
// from the live tldraw store and provides a debounced autosave that PUTs the
// full snapshot + derived rows to `/api/boards/[id]/snapshot`.
//
// Everything here is best-effort: nothing throws into the live board path.

import type { Editor, TLShape, TLShapeId } from '@tldraw/tldraw'

// ─── Derived-row shapes (match the board_nodes / board_edges DB columns) ──────
export interface DerivedNode {
  node_id: string
  kind: 'mindMap' | 'flow' | 'image'
  label: string | null
  subtitle: string | null
  position: { x: number; y: number } | null
  url: string | null
  status: string | null
}

export interface DerivedEdge {
  from_id: string
  to_id: string
}

export interface Derived {
  nodes: DerivedNode[]
  edges: DerivedEdge[]
}

// Map a custom tldraw shape type → the persisted node kind.
const TYPE_TO_KIND: Record<string, DerivedNode['kind']> = {
  'mind-map-node': 'mindMap',
  'flow-node': 'flow',
  'image-node': 'image',
}

/**
 * Extract durable node/edge rows from the current tldraw page.
 *
 * Nodes: custom shapes (`mind-map-node`, `flow-node`, `image-node`) become rows
 *   keyed by their tldraw shape id (a stable, unique string used as `node_id`).
 * Edges: arrows bound to two custom nodes become a directed edge, resolved via
 *   tldraw arrow bindings (terminal 'start' → from, 'end' → to).
 *
 * Pure + defensive: never throws. Returns empty arrays on any failure.
 */
export function extractDerived(editor: Editor): Derived {
  const nodes: DerivedNode[] = []
  const edges: DerivedEdge[] = []

  try {
    const shapes = editor.getCurrentPageShapes()
    const nodeIds = new Set<string>()

    for (const shape of shapes) {
      const kind = TYPE_TO_KIND[shape.type]
      if (!kind) continue
      nodeIds.add(shape.id)
      const props = (shape.props ?? {}) as {
        label?: string
        subtitle?: string
        prompt?: string
        url?: string
        status?: string
      }
      nodes.push({
        node_id: shape.id,
        kind,
        // Image nodes carry their text in `prompt`; node kinds carry `label`.
        label: kind === 'image' ? props.prompt ?? null : props.label ?? null,
        subtitle: props.subtitle ?? null,
        position:
          typeof shape.x === 'number' && typeof shape.y === 'number'
            ? { x: shape.x, y: shape.y }
            : null,
        url: props.url ?? null,
        status: props.status ?? null,
      })
    }

    // Edges: walk arrows, resolve their start/end bindings to node shape ids.
    for (const shape of shapes) {
      if (shape.type !== 'arrow') continue
      const { from, to } = resolveArrowEndpoints(editor, shape.id)
      if (!from || !to) continue
      // Only keep edges whose endpoints are BOTH persisted nodes.
      if (!nodeIds.has(from) || !nodeIds.has(to)) continue
      edges.push({ from_id: from, to_id: to })
    }
  } catch (err) {
    console.warn('[persistence] extractDerived failed:', (err as Error).message)
    return { nodes: [], edges: [] }
  }

  return { nodes, edges }
}

function resolveArrowEndpoints(
  editor: Editor,
  arrowId: TLShapeId,
): { from?: string; to?: string } {
  let from: string | undefined
  let to: string | undefined
  try {
    const bindings = editor.getBindingsFromShape(arrowId, 'arrow') as Array<{
      toId: string
      props?: { terminal?: 'start' | 'end' }
    }>
    for (const b of bindings) {
      if (b.props?.terminal === 'start') from = b.toId
      else if (b.props?.terminal === 'end') to = b.toId
    }
  } catch {
    /* arrow binding util may be unavailable — skip this edge */
  }
  return { from, to }
}

// ─── Debounced autosave ───────────────────────────────────────────────────────
// Serializes the full tldraw snapshot + derived rows and PUTs them to the
// per-board snapshot route. Best-effort: failures are logged, never thrown.

const DEFAULT_DEBOUNCE_MS = 1500

export interface AutosaveHandle {
  /** Schedule a debounced save (resets the timer on each call). */
  schedule: () => void
  /** Flush immediately, cancelling any pending debounce. */
  flush: () => Promise<void>
  /** Cancel any pending timer (call on unmount). */
  cancel: () => void
}

/**
 * Create a debounced autosave bound to a board id + editor. The caller wires
 * `schedule()` into a tldraw store listener and `cancel()` into cleanup.
 */
export function createAutosave(
  boardId: string,
  editor: Editor,
  opts: { debounceMs?: number } = {},
): AutosaveHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let dirtyWhileInFlight = false

  async function save(): Promise<void> {
    if (inFlight) {
      // Coalesce: remember we still need a save once the current one finishes.
      dirtyWhileInFlight = true
      return
    }
    inFlight = true
    try {
      const snapshot = editor.getSnapshot()
      const derived = extractDerived(editor)
      const res = await fetch(
        `/api/boards/${encodeURIComponent(boardId)}/snapshot`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            snapshot,
            nodes: derived.nodes,
            edges: derived.edges,
          }),
        },
      )
      if (!res.ok) {
        console.warn('[persistence] autosave non-ok:', res.status)
      }
    } catch (err) {
      console.warn('[persistence] autosave failed:', (err as Error).message)
    } finally {
      inFlight = false
      if (dirtyWhileInFlight) {
        dirtyWhileInFlight = false
        // Re-run once to capture edits that landed mid-save.
        void save()
      }
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void save()
    }, debounceMs)
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await save()
  }

  function cancel(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { schedule, flush, cancel }
}

// Re-export for callers that want the shape type without importing TLShape.
export type { TLShape }
