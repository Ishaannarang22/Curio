import { Editor, Box, TLArrowBinding } from '@tldraw/tldraw'

/**
 * layoutGuard — the CLIENT-side guarantee that no two whiteboard blocks overlap.
 *
 * The agent only PROPOSES positions; this module makes overlap structurally
 * impossible. It is REACTIVE: it runs at creation (via seedPosition) and again
 * whenever any shape's real bounds change (markdown grows, ELK/d3 settle, user
 * drag/resize). Resolution PUSHES NEIGHBORS APART along the minimum-translation
 * axis, cascading until nothing overlaps.
 *
 *   • The more-recently-changed (newer / growing) cluster HOLDS its position;
 *     its neighbors yield (anchorScore = max lastChanged time).
 *   • User-dragged shapes are PINNED (anchorScore = Infinity) so the guard never
 *     fights the user — their whole cluster is immovable.
 *
 * A "cluster" is a connected component of non-arrow shapes joined by arrow
 * bindings, so a flowchart/mindmap moves as ONE rigid unit (we never separate a
 * diagram's internal nodes).
 */

// ─── Module-level state (single board instance) ───────────────────────────────
const pinned = new Set<string>() // user-moved shape ids; their cluster never moves
const lastChanged = new Map<string, number>() // shapeId -> Date.now() of last change
let suppress = false // true while the guard writes, so its own writes don't recurse
let timer: ReturnType<typeof setTimeout> | null = null

// ─── Constants ────────────────────────────────────────────────────────────────
const GAP = 28 // min gap between blocks, px
const MAX_ITERS = 24 // resolve passes per run
const DEBOUNCE_MS = 360
const DEFAULT_BLOCK = 320 // a sensible default block size for spiral stepping

// ─── Cluster type ─────────────────────────────────────────────────────────────
interface Cluster {
  ids: string[]
  bounds: Box
  anchorScore: number
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Mark shapes the user moved/resized — their cluster becomes immovable. */
export function markUserMoved(ids: string[]): void {
  for (const id of ids) pinned.add(id)
}

/** Record that these shapes just changed (drives "newer holds"). */
export function noteChanged(ids: string[]): void {
  const now = Date.now()
  for (const id of ids) lastChanged.set(id, now)
}

/** True while the guard is applying its own writes (so listeners can ignore them). */
export function isSuppressed(): boolean {
  return suppress
}

/** Debounced entry point — schedule an overlap-resolution pass. */
export function scheduleResolve(editor: Editor): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    try {
      runResolve(editor)
    } catch {
      /* never throw from the guard */
    }
  }, DEBOUNCE_MS)
}

/** Clear all guard state (called from clearBoard). */
export function resetLayoutState(): void {
  pinned.clear()
  lastChanged.clear()
}

/**
 * Pick a birth position whose w×h rect (inflated by GAP) does not overlap any
 * existing block. Starts from `preferred` (or viewport center); if free, returns
 * it; otherwise spirals outward and returns the first free candidate. Falls back
 * to the preferred/center point if nothing free is found within the cap.
 */
export function seedPosition(
  editor: Editor,
  w: number,
  h: number,
  preferred?: { x: number; y: number },
): { x: number; y: number } {
  let start: { x: number; y: number }
  if (preferred) {
    start = { x: preferred.x, y: preferred.y }
  } else {
    try {
      const vp = editor.getViewportPageBounds()
      start = { x: vp.x + vp.w / 2 - w / 2, y: vp.y + vp.h / 2 - h / 2 }
    } catch {
      start = { x: 0, y: 0 }
    }
  }

  let obstacles: Box[]
  try {
    obstacles = buildClusters(editor).map((c) => c.bounds)
  } catch {
    obstacles = []
  }

  const isFree = (x: number, y: number): boolean => {
    const rect = new Box(x - GAP, y - GAP, w + GAP * 2, h + GAP * 2)
    for (const o of obstacles) {
      if (Box.Collides(rect, o)) return false
    }
    return true
  }

  if (isFree(start.x, start.y)) return start

  // Expanding square-ring spiral search around `start`.
  const step = DEFAULT_BLOCK + GAP
  const MAX_RINGS = 20 // 20 rings ≈ up to ~1680 candidate cells; capped below too
  let probed = 0
  for (let ring = 1; ring <= MAX_RINGS; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        // Only the ring's perimeter (skip interior already probed).
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        if (probed++ > 400) return start
        const cx = start.x + dx * step
        const cy = start.y + dy * step
        if (isFree(cx, cy)) return { x: cx, y: cy }
      }
    }
  }
  return start
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** Union-find: build clusters of non-arrow shapes joined by arrow bindings. */
function buildClusters(editor: Editor): Cluster[] {
  const pageId = editor.getCurrentPageId()
  const allShapes = editor.getCurrentPageShapes()

  // Candidate (block) ids: non-arrow shapes parented directly to the page.
  const candidateIds = new Set<string>()
  for (const s of allShapes) {
    if (s.typeName === 'shape' && s.parentId === pageId && s.type !== 'arrow') {
      candidateIds.add(s.id)
    }
  }

  // Union-find structures.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // Path compression.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const id of candidateIds) parent.set(id, id)

  // Union along arrow bindings (so a diagram = one cluster).
  for (const s of allShapes) {
    if (s.type !== 'arrow') continue
    let bindings: TLArrowBinding[]
    try {
      bindings = editor.getBindingsFromShape<TLArrowBinding>(s.id, 'arrow')
    } catch {
      continue
    }
    const bound = bindings
      .map((b) => b.toId as string)
      .filter((toId) => candidateIds.has(toId))
    for (let i = 1; i < bound.length; i++) union(bound[0], bound[i])
  }

  // Group candidate ids by root.
  const groups = new Map<string, string[]>()
  for (const id of candidateIds) {
    const root = find(id)
    const g = groups.get(root)
    if (g) g.push(id)
    else groups.set(root, [id])
  }

  // Build cluster bounds + anchorScore.
  const clusters: Cluster[] = []
  for (const ids of groups.values()) {
    let bounds: Box | undefined
    let anchorScore = 0
    const liveIds: string[] = []
    for (const id of ids) {
      const b = editor.getShapePageBounds(id as never)
      if (!b) continue
      liveIds.push(id)
      bounds = bounds ? bounds.clone().union(b) : b.clone()
      if (pinned.has(id)) {
        anchorScore = Infinity
      } else if (anchorScore !== Infinity) {
        anchorScore = Math.max(anchorScore, lastChanged.get(id) ?? 0)
      }
    }
    if (!bounds || liveIds.length === 0) continue
    clusters.push({ ids: liveIds, bounds, anchorScore })
  }
  return clusters
}

/**
 * Minimum-translation vector to separate B from A. `a` is inflated by `gap` on
 * all sides; returns the vector to APPLY TO B, or null if they don't overlap.
 */
function overlapMTV(a: Box, b: Box, gap: number): { dx: number; dy: number } | null {
  const ax = a.x - gap
  const ay = a.y - gap
  const aw = a.w + gap * 2
  const ah = a.h + gap * 2

  // Axis penetration depths.
  const px = Math.min(ax + aw, b.x + b.w) - Math.max(ax, b.x)
  const py = Math.min(ay + ah, b.y + b.h) - Math.max(ay, b.y)
  if (px <= 0 || py <= 0) return null

  const aCenterX = ax + aw / 2
  const aCenterY = ay + ah / 2
  const bCenterX = b.x + b.w / 2
  const bCenterY = b.y + b.h / 2

  if (px < py) {
    const dir = bCenterX >= aCenterX ? 1 : -1
    return { dx: dir * px, dy: 0 }
  } else {
    const dir = bCenterY >= aCenterY ? 1 : -1
    return { dx: 0, dy: dir * py }
  }
}

/** Translate every shape in a cluster by (dx, dy). */
function translateCluster(editor: Editor, cluster: Cluster, dx: number, dy: number): void {
  for (const id of cluster.ids) {
    const shape = editor.getShape(id as never)
    if (!shape) continue
    editor.updateShape({ id: shape.id, type: shape.type, x: shape.x + dx, y: shape.y + dy })
  }
}

/** One resolution run: iteratively push overlapping clusters apart. */
function runResolve(editor: Editor): void {
  // Don't fight an in-progress drag — defer past it.
  if (editor.inputs.isPointing) {
    scheduleResolve(editor)
    return
  }

  suppress = true
  try {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const clusters = buildClusters(editor)
      let moved = false

      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i]
          const b = clusters[j]
          const mtv = overlapMTV(a.bounds, b.bounds, GAP)
          if (!mtv) continue

          // Both pinned/immovable → can't resolve this pair, skip.
          if (a.anchorScore === Infinity && b.anchorScore === Infinity) continue

          // Decide who yields: higher anchorScore HOLDS, the other moves.
          let moveB: boolean
          if (a.anchorScore === Infinity) {
            moveB = true // A immovable → B moves
          } else if (b.anchorScore === Infinity) {
            moveB = false // B immovable → A moves
          } else {
            moveB = a.anchorScore >= b.anchorScore // A holds → B moves
          }

          if (moveB) {
            translateCluster(editor, b, mtv.dx, mtv.dy)
            b.bounds = b.bounds.clone().translate({ x: mtv.dx, y: mtv.dy })
          } else {
            translateCluster(editor, a, -mtv.dx, -mtv.dy)
            a.bounds = a.bounds.clone().translate({ x: -mtv.dx, y: -mtv.dy })
          }
          moved = true
        }
      }

      if (!moved) break
    }
  } finally {
    suppress = false
  }
}
