import {
  Editor,
  TLShapeId,
  createShapeId,
  toRichText,
} from '@tldraw/tldraw'
import ELK from 'elkjs/lib/elk.bundled.js'
import { shapeSupportsProp } from './safeShapeWrites'
import { seedPosition, resetLayoutState } from './layoutGuard'
import { sanitizeMarkdown } from '../editor/markdown'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  SimulationNodeDatum,
  SimulationLinkDatum,
} from 'd3-force'

// ─── Internal ID map ─────────────────────────────────────────────────────────
const idMap = new Map<string, TLShapeId>()

function getTLId(internalId: string): TLShapeId | undefined {
  return idMap.get(internalId)
}

function setTLId(internalId: string, tlId: TLShapeId) {
  idMap.set(internalId, tlId)
}

async function animateShapeTo(
  editor: Editor,
  shapeId: TLShapeId,
  x: number,
  y: number,
  duration = 400
) {
  editor.animateShape(
    { id: shapeId, type: editor.getShape(shapeId)!.type, x, y },
    { animation: { duration, easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t } }
  )
  await sleep(duration)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// ─── ELK instance ─────────────────────────────────────────────────────────────
const elk = new ELK()

// ─── addNote ──────────────────────────────────────────────────────────────────
// Optional `internalId` registers the sticky in the idMap so it can be
// addressed by update_node / move_block / remove_block. Backward-compat: callers
// that omit internalId still work — the shape just won't be idMap-addressable.
export function addNote(
  editor: Editor,
  text: string,
  position?: { x: number; y: number },
  color?: string,
  internalId?: string
) {
  const tlId = createShapeId()
  const pos = seedPosition(editor, 200, 200, position)
  // Register in idMap if a semantic id was provided (add_sticky path).
  if (internalId) {
    const existing = getTLId(internalId)
    if (existing && editor.getShape(existing)) {
      // Upsert: update the existing note in place.
      // tldraw's note shape stores text as structured richText (the legacy
      // `text` prop was removed by the AddRichText migration), so convert here.
      editor.updateShape({ id: existing, type: 'note', props: { richText: toRichText(text), color: color ?? 'yellow' } })
      return
    }
    setTLId(internalId, tlId)
  }
  editor.createShape({
    id: tlId,
    type: 'note',
    x: pos.x,
    y: pos.y,
    props: { richText: toRichText(text), color: color ?? 'yellow', size: 'm', font: 'sans' },
  })
  scheduleAppearAnimation(editor, tlId)
}

// Non-overlapping birth position. The layout guard probes existing block bounds
// and returns a free spot for a default-sized block; callers with a known size
// and an agent-proposed position should use seedPosition directly (below).
function randomPosition(editor: Editor) {
  return seedPosition(editor, 320, 240)
}

// ─── addExplanation ────────────────────────────────────────────────────────────
export function addExplanation(
  editor: Editor,
  internalId: string,
  text: string,
  position?: { x: number; y: number }
) {
  let tlId = getTLId(internalId)
  const pos = seedPosition(editor, 300, 180, position)

  if (tlId && editor.getShape(tlId)) {
    editor.updateShape({
      id: tlId,
      type: 'explanation-card',
      props: { text, revealedLength: text.length },
    })
    return
  }

  tlId = createShapeId()
  setTLId(internalId, tlId)

  editor.createShape({
    id: tlId,
    type: 'explanation-card',
    x: pos.x,
    y: pos.y,
    props: { text, revealedLength: 0, w: 300, h: 180, highlighted: false },
  })

  scheduleAppearAnimation(editor, tlId)

  // Trigger typewriter: animate revealedLength 0 -> text.length
  animateReveal(editor, tlId, text, 0)
}

export function appendToExplanation(
  editor: Editor,
  internalId: string,
  moreText: string
) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  const shape = editor.getShape(tlId)
  if (!shape) return
  const current = (shape.props as { text: string }).text
  const newText = current + '\n' + moreText
  // Update text — ExplanationCard's useEffect detects the append and animates
  editor.updateShape({
    id: tlId,
    type: 'explanation-card',
    props: { text: newText },
  })
}

function animateReveal(
  editor: Editor,
  tlId: TLShapeId,
  text: string,
  startFrom: number
) {
  const totalChars = text.length
  const duration = Math.min(900, Math.max(600, totalChars * 18))
  const startTime = performance.now()

  const tick = (now: number) => {
    const elapsed = now - startTime
    const progress = Math.min(elapsed / duration, 1)
    const chars = Math.floor(startFrom + (totalChars - startFrom) * progress)
    try {
      editor.updateShape({
        id: tlId,
        type: 'explanation-card',
        props: { revealedLength: chars },
      })
    } catch { /* shape may have been removed */ }
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// ─── addMarkdown ───────────────────────────────────────────────────────────────
// Renders a markdown document as ONE auto-growing tldraw shape, edited in place
// with a Notion-style WYSIWYG editor (see shapes/MarkdownDoc.tsx). Pass the
// markdown text as `markdown` (the harness/caller supplies it; the browser can't
// read files). An optional `id` lets the voice agent update/replace a doc it
// created earlier instead of stacking a new one.
export function addMarkdown(
  editor: Editor,
  markdown: string,
  options?: {
    id?: string
    position?: { x: number; y: number }
    size?: { w?: number; h?: number }
  }
) {
  const md = sanitizeMarkdown(markdown)
  if (!md.trim()) return

  const key = options?.id ?? `md_${Date.now()}`
  const w = options?.size?.w ?? 420

  // Update-by-id: if this doc already exists, replace its content in place.
  if (options?.id) {
    const existing = getTLId(key)
    if (existing && editor.getShape(existing)) {
      editor.updateShape({ id: existing, type: 'markdown-doc', props: { markdown: md } })
      return
    }
  }

  const anchor = seedPosition(editor, w, 200, options?.position)
  const id = createShapeId()
  setTLId(key, id)
  editor.createShape({
    id,
    type: 'markdown-doc',
    x: anchor.x,
    y: anchor.y,
    // h is a placeholder; the shape measures its real content height and grows.
    props: { w, h: 120, markdown: md, highlighted: false },
  })
  scheduleAppearAnimation(editor, id)
}

// ─── addFlowNode ──────────────────────────────────────────────────────────────
export function addFlowNode(
  editor: Editor,
  internalId: string,
  label: string,
  subtitle?: string,
  position?: { x: number; y: number }
) {
  let tlId = getTLId(internalId)
  if (tlId && editor.getShape(tlId)) {
    editor.updateShape({
      id: tlId,
      type: 'flow-node',
      props: { label, subtitle: subtitle ?? '' },
    })
    return
  }

  tlId = createShapeId()
  setTLId(internalId, tlId)
  const pos = seedPosition(editor, 180, subtitle ? 80 : 60, position)

  editor.createShape({
    id: tlId,
    type: 'flow-node',
    x: pos.x,
    y: pos.y,
    props: { label, subtitle: subtitle ?? '', w: 180, h: subtitle ? 80 : 60, highlighted: false },
  })
  scheduleAppearAnimation(editor, tlId)
}

// ─── addMindMapNode ───────────────────────────────────────────────────────────
export function addMindMapNode(
  editor: Editor,
  internalId: string,
  label: string,
  parentId?: string,
  position?: { x: number; y: number }
) {
  let tlId = getTLId(internalId)
  if (tlId && editor.getShape(tlId)) {
    editor.updateShape({ id: tlId, type: 'mind-map-node', props: { label } })
    return
  }

  tlId = createShapeId()
  setTLId(internalId, tlId)
  const pos = seedPosition(editor, 140, 44, position)

  editor.createShape({
    id: tlId,
    type: 'mind-map-node',
    x: pos.x,
    y: pos.y,
    props: { label, isCenter: !parentId, w: 140, h: 44, highlighted: false },
  })
  scheduleAppearAnimation(editor, tlId)

  if (parentId) {
    const parentTlId = getTLId(parentId)
    if (parentTlId) connectNodes(editor, parentId, internalId)
  }
}

// ─── connectNodes ─────────────────────────────────────────────────────────────
export function connectNodes(
  editor: Editor,
  fromId: string,
  toId: string,
  label?: string,
  // Mind-map links are plain lines; flowchart links get a subtle arrowhead at
  // the destination to show direction.
  directed = false
) {
  const fromTl = getTLId(fromId)
  const toTl = getTLId(toId)
  if (!fromTl || !toTl) return

  const fromShape = editor.getShape(fromTl)
  const toShape = editor.getShape(toTl)
  if (!fromShape || !toShape) return

  // Place arrow between the two shapes
  const fx = fromShape.x + ((fromShape.props as { w: number }).w ?? 80) / 2
  const fy = fromShape.y + ((fromShape.props as { h: number }).h ?? 40) / 2
  const tx = toShape.x + ((toShape.props as { w: number }).w ?? 80) / 2
  const ty = toShape.y + ((toShape.props as { h: number }).h ?? 40) / 2

  const arrowId = createShapeId()
  editor.createShape({
    id: arrowId,
    type: 'arrow',
    x: 0,
    y: 0,
    props: {
      start: { x: fx, y: fy },
      end: { x: tx, y: ty },
      text: label ?? '',
      color: 'grey',
      size: 's',
      arrowheadStart: 'none',
      arrowheadEnd: directed ? 'arrow' : 'none',
    },
  })

  // Bind start to fromShape, end to toShape
  editor.createBinding({
    type: 'arrow',
    fromId: arrowId,
    toId: fromTl,
    props: {
      terminal: 'start',
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
    },
  })
  editor.createBinding({
    type: 'arrow',
    fromId: arrowId,
    toId: toTl,
    props: {
      terminal: 'end',
      normalizedAnchor: { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: false,
    },
  })
}

// ─── updateNode ───────────────────────────────────────────────────────────────
export function updateNode(editor: Editor, internalId: string, newLabel: string) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  const shape = editor.getShape(tlId)
  if (!shape) return
  editor.updateShape({ id: tlId, type: shape.type, props: { label: newLabel } })
}

// ─── removeNode ───────────────────────────────────────────────────────────────
export function removeNode(editor: Editor, internalId: string) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  editor.deleteShapes([tlId])
  idMap.delete(internalId)
}

// ─── requestImage ─────────────────────────────────────────────────────────────
export function requestImage(
  editor: Editor,
  internalId: string,
  prompt: string,
  position?: { x: number; y: number }
) {
  let tlId = getTLId(internalId)
  const pos = seedPosition(editor, 300, 220, position)

  if (tlId && editor.getShape(tlId)) {
    editor.updateShape({
      id: tlId,
      type: 'image-node',
      props: { prompt, status: 'loading', url: '' },
    })
    return
  }

  tlId = createShapeId()
  setTLId(internalId, tlId)

  editor.createShape({
    id: tlId,
    type: 'image-node',
    x: pos.x,
    y: pos.y,
    props: { prompt, url: '', status: 'loading', w: 300, h: 220, highlighted: false },
  })
  scheduleAppearAnimation(editor, tlId)
}

// ─── resolveImage ─────────────────────────────────────────────────────────────
export function resolveImage(editor: Editor, internalId: string, url: string) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) return
  editor.updateShape({
    id: tlId,
    type: 'image-node',
    props: { url, status: 'loaded' },
  })
}

// ─── highlightNode ────────────────────────────────────────────────────────────
export async function highlightNode(editor: Editor, internalId: string) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  const shape = editor.getShape(tlId)
  if (!shape) return

  // Pan camera if off-screen
  const vpBounds = editor.getViewportPageBounds()
  const shapeBounds = editor.getShapePageBounds(tlId)
  if (shapeBounds && !vpBounds.contains(shapeBounds)) {
    editor.centerOnPoint(
      { x: shapeBounds.x + shapeBounds.w / 2, y: shapeBounds.y + shapeBounds.h / 2 },
      { animation: { duration: 400 } }
    )
    await sleep(420)
  }

  // Pulse for 1.2s. Custom shapes have a `highlighted` prop; built-in shapes
  // (e.g. note) don't — for those, pulse via selection so highlight still works.
  if (shapeSupportsProp(editor, shape.type, 'highlighted')) {
    editor.updateShape({ id: tlId, type: shape.type, props: { highlighted: true } })
    await sleep(1200)
    editor.updateShape({ id: tlId, type: shape.type, props: { highlighted: false } })
  } else {
    const prev = editor.getSelectedShapeIds()
    editor.setSelectedShapes([tlId])
    await sleep(1200)
    editor.setSelectedShapes(prev)
  }
}

// ─── clearBoard ───────────────────────────────────────────────────────────────
export function clearBoard(editor: Editor) {
  const allIds = editor.getCurrentPageShapeIds()
  editor.deleteShapes([...allIds])
  idMap.clear()
  resetLayoutState()
}

// ─── addMindMap ───────────────────────────────────────────────────────────────
export async function addMindMap(
  editor: Editor,
  blockId: string,
  centerLabel: string,
  branches: { id: string; label: string }[],
  position?: { x: number; y: number }
) {
  const centerId = `${blockId}__center`

  // Anchor the whole map at the current viewport center so it's never
  // laid out off-screen near page origin (0,0).
  const vp = editor.getViewportPageBounds()
  const anchorX = position?.x ?? vp.x + vp.w / 2
  const anchorY = position?.y ?? vp.y + vp.h / 2

  // Create center if needed
  let centerTlId = getTLId(centerId)
  if (!centerTlId || !editor.getShape(centerTlId)) {
    centerTlId = createShapeId()
    setTLId(centerId, centerTlId)
    editor.createShape({
      id: centerTlId,
      type: 'mind-map-node',
      x: anchorX - 80,
      y: anchorY - 26,
      props: { label: centerLabel, isCenter: true, w: 160, h: 52, highlighted: false },
    })
    scheduleAppearAnimation(editor, centerTlId)
  } else {
    editor.updateShape({ id: centerTlId, type: 'mind-map-node', props: { label: centerLabel } })
  }

  // Create branch nodes that don't exist yet, seeded near the center so the
  // force sim spreads them outward from a sensible starting point.
  for (const branch of branches) {
    let branchTlId = getTLId(branch.id)
    if (!branchTlId || !editor.getShape(branchTlId)) {
      branchTlId = createShapeId()
      setTLId(branch.id, branchTlId)
      editor.createShape({
        id: branchTlId,
        type: 'mind-map-node',
        x: anchorX - 70 + (Math.random() * 80 - 40),
        y: anchorY - 22 + (Math.random() * 80 - 40),
        props: { label: branch.label, isCenter: false, w: 140, h: 44, highlighted: false },
      })
      scheduleAppearAnimation(editor, branchTlId)
      connectNodes(editor, centerId, branch.id)
    }
  }

  // Run d3-force layout
  await runD3ForceLayout(editor, centerId, branches.map((b) => b.id))

  // Bring the whole structure comfortably into view.
  await zoomToContent(editor)
}

// Gently fit all shapes into the viewport with a smooth animation.
// Caps zoom at 100% so small structures aren't blown up awkwardly.
async function zoomToContent(editor: Editor) {
  const bounds = editor.getCurrentPageBounds()
  if (!bounds) return
  editor.zoomToBounds(bounds, {
    animation: { duration: 400 },
    inset: 80,
    targetZoom: Math.min(1, editor.getViewportScreenBounds().w / (bounds.w + 160)),
  })
  await sleep(420)
}

async function runD3ForceLayout(
  editor: Editor,
  centerId: string,
  branchIds: string[]
) {
  type FNode = SimulationNodeDatum & { id: string; fx?: number | null; fy?: number | null }
  type FLink = SimulationLinkDatum<FNode>

  const centerShape = editor.getShape(getTLId(centerId)!)!
  const cx = centerShape.x + 80
  const cy = centerShape.y + 26

  const nodes: FNode[] = [
    { id: centerId, x: cx, y: cy, fx: cx, fy: cy },
    ...branchIds.map((id) => {
      const s = editor.getShape(getTLId(id)!)
      return { id, x: s?.x ?? cx + Math.random() * 200 - 100, y: s?.y ?? cy }
    }),
  ]

  const links: FLink[] = branchIds.map((id) => ({
    source: centerId,
    target: id,
  }))

  // Settle the simulation SYNCHRONOUSLY rather than animating every tick.
  // A fixed center node anchors the layout, so no forceCenter is needed
  // (forceCenter would re-center the centroid each tick and fight the fixed
  // node, causing the whole cloud to drift). Charge repels branches apart,
  // link springs them to the center, collide prevents overlap.
  const sim = forceSimulation<FNode>(nodes)
    .force('link', forceLink<FNode, FLink>(links).id((d) => d.id).distance(180).strength(0.9))
    .force('charge', forceManyBody().strength(-600))
    .force('collide', forceCollide(85))
    .stop()

  // Tick to convergence off-screen (deterministic, no visual thrash).
  const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()))
  for (let i = 0; i < ticks; i++) sim.tick()

  // Animate every branch to its settled position once, over ~400ms.
  const partials = nodes
    .filter((n) => n.id !== centerId)
    .map((n) => {
      const tlId = getTLId(n.id)
      if (!tlId) return null
      return { id: tlId, type: 'mind-map-node' as const, x: (n.x ?? cx) - 70, y: (n.y ?? cy) - 22 }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
  editor.animateShapes(partials, {
    animation: { duration: 400, easing: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t) },
  })
  await sleep(420)
}

// ─── addFlowchart ─────────────────────────────────────────────────────────────
export async function addFlowchart(
  editor: Editor,
  steps: { id: string; label: string; subtitle?: string }[],
  position?: { x: number; y: number }
) {
  editor.batch(() => {
    for (const step of steps) {
      let tlId = getTLId(step.id)
      if (!tlId || !editor.getShape(tlId)) {
        tlId = createShapeId()
        setTLId(step.id, tlId)
        editor.createShape({
          id: tlId,
          type: 'flow-node',
          x: 0,
          y: 0,
          props: {
            label: step.label,
            subtitle: step.subtitle ?? '',
            w: 180,
            h: step.subtitle ? 80 : 60,
            highlighted: false,
          },
        })
        scheduleAppearAnimation(editor, tlId)
      }
    }

    // Connect sequentially — flowchart edges are directional.
    for (let i = 0; i < steps.length - 1; i++) {
      connectNodes(editor, steps[i].id, steps[i + 1].id, undefined, true)
    }
  })

  await runElkLayout(editor, steps, position)

  // Bring the whole flowchart comfortably into view.
  await zoomToContent(editor)
}

async function runElkLayout(
  editor: Editor,
  steps: { id: string }[],
  position?: { x: number; y: number }
) {
  const elkNodes = steps.map((s) => {
    const tlId = getTLId(s.id)!
    const shape = editor.getShape(tlId)!
    return {
      id: s.id,
      width: (shape.props as { w: number }).w,
      height: (shape.props as { h: number }).h,
    }
  })

  const elkEdges = steps.slice(0, -1).map((s, i) => ({
    id: `e${i}`,
    sources: [s.id],
    targets: [steps[i + 1].id],
  }))

  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    },
    children: elkNodes,
    edges: elkEdges,
  })

  const vp = editor.getViewportPageBounds()
  const originX = position?.x ?? vp.x + vp.w / 2 - (graph.width ?? 0) / 2
  const originY = position?.y ?? vp.y + vp.h / 4

  const promises = (graph.children ?? []).map((node) => {
    const tlId = getTLId(node.id)
    if (!tlId) return Promise.resolve()
    return animateShapeTo(
      editor,
      tlId,
      originX + (node.x ?? 0),
      originY + (node.y ?? 0),
      400
    )
  })

  await Promise.all(promises)
}

// ─── addDiagram ───────────────────────────────────────────────────────────────
// A free-form relationship graph: arbitrary nodes connected by (optionally
// labelled) edges — distinct from the mind-map (radial star) and flowchart
// (linear sequence). Nodes reuse the mind-map-node shape; layout is a general
// d3-force pass over the actual edge set (not just centre→branch), centred on
// the anchor. `position` is treated as the CENTRE of the diagram (Python passes
// the centre of its reserved slot so the spread stays inside that region).
export async function addDiagram(
  editor: Editor,
  blockId: string,
  nodes: { id: string; label: string }[],
  edges: { fromId: string; toId: string; label?: string }[],
  position?: { x: number; y: number }
) {
  void blockId
  const vp = editor.getViewportPageBounds()
  const cx = position?.x ?? vp.x + vp.w / 2
  const cy = position?.y ?? vp.y + vp.h / 2

  // Create (or update) every node, seeded near the centre so the sim spreads
  // them outward from a sensible start.
  for (const n of nodes) {
    let tlId = getTLId(n.id)
    if (!tlId || !editor.getShape(tlId)) {
      tlId = createShapeId()
      setTLId(n.id, tlId)
      editor.createShape({
        id: tlId,
        type: 'mind-map-node',
        x: cx - 75 + (Math.random() * 120 - 60),
        y: cy - 24 + (Math.random() * 120 - 60),
        props: { label: n.label, isCenter: false, w: 150, h: 48, highlighted: false },
      })
      scheduleAppearAnimation(editor, tlId)
    } else {
      editor.updateShape({ id: tlId, type: 'mind-map-node', props: { label: n.label } })
    }
  }

  // Draw the edges (bound arrows follow the nodes once the sim settles them).
  for (const e of edges) {
    connectNodes(editor, e.fromId, e.toId, e.label)
  }

  await runDiagramForceLayout(editor, nodes.map((n) => n.id), edges, cx, cy)
  await zoomToContent(editor)
}

async function runDiagramForceLayout(
  editor: Editor,
  nodeIds: string[],
  edges: { fromId: string; toId: string }[],
  cx: number,
  cy: number
) {
  type FNode = SimulationNodeDatum & { id: string }
  type FLink = SimulationLinkDatum<FNode>

  const nodes: FNode[] = nodeIds.map((id) => {
    const s = editor.getShape(getTLId(id)!)
    return { id, x: (s?.x ?? cx) + 75, y: (s?.y ?? cy) + 24 }
  })

  // Only keep edges whose endpoints both exist as nodes.
  const valid = new Set(nodeIds)
  const links: FLink[] = edges
    .filter((e) => valid.has(e.fromId) && valid.has(e.toId))
    .map((e) => ({ source: e.fromId, target: e.toId }))

  // No fixed node here (unlike the mind-map), so forceCenter keeps the whole
  // graph anchored at (cx, cy) instead of drifting. Charge repels, links spring,
  // collide prevents overlap.
  const sim = forceSimulation<FNode>(nodes)
    .force('link', forceLink<FNode, FLink>(links).id((d) => d.id).distance(170).strength(0.6))
    .force('charge', forceManyBody().strength(-700))
    .force('collide', forceCollide(95))
    .force('center', forceCenter(cx, cy))
    .stop()

  const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()))
  for (let i = 0; i < ticks; i++) sim.tick()

  const partials = nodes
    .map((n) => {
      const tlId = getTLId(n.id)
      if (!tlId) return null
      return { id: tlId, type: 'mind-map-node' as const, x: (n.x ?? cx) - 75, y: (n.y ?? cy) - 24 }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
  editor.animateShapes(partials, {
    animation: { duration: 400, easing: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t) },
  })
  await sleep(420)
}

// ─── appendMarkdown ───────────────────────────────────────────────────────────
// Appends new markdown below an existing markdown-doc shape (found via idMap).
// If the id doesn't exist in the idMap, this is a no-op (safe to call speculatively).
export function appendMarkdown(editor: Editor, internalId: string, markdown: string) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  const shape = editor.getShape(tlId)
  if (!shape) return
  const current = (shape.props as { markdown: string }).markdown ?? ''
  editor.updateShape({
    id: tlId,
    type: 'markdown-doc',
    props: { markdown: current + '\n\n' + markdown },
  })
}

// ─── moveShape ────────────────────────────────────────────────────────────────
// Animates an existing shape (any type) to absolute page coords (x, y).
// Resolves the tldraw shape id via idMap; no-op if not found.
export function moveShape(editor: Editor, internalId: string, x: number, y: number) {
  const tlId = getTLId(internalId)
  if (!tlId) return
  const shape = editor.getShape(tlId)
  if (!shape) return
  editor.animateShape(
    { id: tlId, type: shape.type, x, y },
    { animation: { duration: 300 } }
  )
}

// ─── Appear animation (CSS keyframe via data attribute) ───────────────────────
function scheduleAppearAnimation(editor: Editor, shapeId: TLShapeId) {
  // We rely on the CSS @keyframes `shape-appear` defined globally
  // Nothing to do here at the tldraw level — the HTMLContainer picks it up
  // via the `.tl-shape[data-shape-id]` selector in global CSS.
  void shapeId
  void editor
}
