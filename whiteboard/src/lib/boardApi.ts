import {
  Editor,
  TLShapeId,
  createShapeId,
} from '@tldraw/tldraw'
import ELK from 'elkjs/lib/elk.bundled.js'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
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

// ─── Animation helpers ────────────────────────────────────────────────────────
const APPEAR_DURATION = 200 // ms for fade-in on new shapes

function animateIn(editor: Editor, shapeId: TLShapeId) {
  // tldraw v3 doesn't expose opacity animation natively via animateShape,
  // so we drive it via a CSS class injected on the HTML container.
  // The shape component itself handles the CSS animation via @keyframes.
  editor.updateShape({ id: shapeId, type: editor.getShape(shapeId)!.type, props: {} })
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
export function addNote(
  editor: Editor,
  text: string,
  position?: { x: number; y: number },
  color?: string
) {
  const id = createShapeId()
  const pos = position ?? randomPosition(editor)
  editor.createShape({
    id,
    type: 'note',
    x: pos.x,
    y: pos.y,
    props: { text, color: color ?? 'yellow', size: 'm', font: 'sans' },
  })
  scheduleAppearAnimation(editor, id)
}

function randomPosition(editor: Editor) {
  const vp = editor.getViewportPageBounds()
  return {
    x: vp.x + vp.w * 0.2 + Math.random() * vp.w * 0.6,
    y: vp.y + vp.h * 0.2 + Math.random() * vp.h * 0.6,
  }
}

// ─── addExplanation ────────────────────────────────────────────────────────────
export function addExplanation(
  editor: Editor,
  internalId: string,
  text: string,
  position?: { x: number; y: number }
) {
  let tlId = getTLId(internalId)
  const pos = position ?? randomPosition(editor)

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
  const pos = position ?? randomPosition(editor)

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
  const pos = position ?? randomPosition(editor)

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
  label?: string
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
  const pos = position ?? randomPosition(editor)

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

  // Pulse: set highlighted on, then off after 1.2s
  editor.updateShape({ id: tlId, type: shape.type, props: { highlighted: true } })
  await sleep(1200)
  editor.updateShape({ id: tlId, type: shape.type, props: { highlighted: false } })
}

// ─── clearBoard ───────────────────────────────────────────────────────────────
export function clearBoard(editor: Editor) {
  const allIds = editor.getCurrentPageShapeIds()
  editor.deleteShapes([...allIds])
  idMap.clear()
}

// ─── addMindMap ───────────────────────────────────────────────────────────────
export async function addMindMap(
  editor: Editor,
  centerLabel: string,
  branches: { id: string; label: string }[]
) {
  const centerId = '__mindmap_center__'

  // Create center if needed
  let centerTlId = getTLId(centerId)
  if (!centerTlId || !editor.getShape(centerTlId)) {
    centerTlId = createShapeId()
    setTLId(centerId, centerTlId)
    editor.createShape({
      id: centerTlId,
      type: 'mind-map-node',
      x: 0,
      y: 0,
      props: { label: centerLabel, isCenter: true, w: 160, h: 52, highlighted: false },
    })
    scheduleAppearAnimation(editor, centerTlId)
  } else {
    editor.updateShape({ id: centerTlId, type: 'mind-map-node', props: { label: centerLabel } })
  }

  // Create branch nodes that don't exist yet
  for (const branch of branches) {
    let branchTlId = getTLId(branch.id)
    if (!branchTlId || !editor.getShape(branchTlId)) {
      branchTlId = createShapeId()
      setTLId(branch.id, branchTlId)
      editor.createShape({
        id: branchTlId,
        type: 'mind-map-node',
        x: 0,
        y: 0,
        props: { label: branch.label, isCenter: false, w: 140, h: 44, highlighted: false },
      })
      scheduleAppearAnimation(editor, branchTlId)
      connectNodes(editor, centerId, branch.id)
    }
  }

  // Run d3-force layout
  await runD3ForceLayout(editor, centerId, branches.map((b) => b.id))
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
    distance: 200,
  }))

  await new Promise<void>((resolve) => {
    const sim = forceSimulation<FNode>(nodes)
      .force('link', forceLink<FNode, FLink>(links).id((d) => d.id).distance(200).strength(0.8))
      .force('charge', forceManyBody().strength(-300))
      .force('center', forceCenter(cx, cy))
      .force('collide', forceCollide(90))
      .alphaDecay(0.05)

    sim.on('tick', () => {
      // Animate each non-center node to its new position
      for (const node of nodes) {
        if (node.id === centerId) continue
        const tlId = getTLId(node.id)
        if (!tlId) continue
        const shape = editor.getShape(tlId)
        if (!shape) continue
        editor.updateShape({ id: tlId, type: shape.type, x: (node.x ?? 0) - 70, y: (node.y ?? 0) - 22 })
      }
    })

    sim.on('end', () => resolve())
  })
}

// ─── addFlowchart ─────────────────────────────────────────────────────────────
export async function addFlowchart(
  editor: Editor,
  steps: { id: string; label: string; subtitle?: string }[]
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

    // Connect sequentially
    for (let i = 0; i < steps.length - 1; i++) {
      connectNodes(editor, steps[i].id, steps[i + 1].id)
    }
  })

  await runElkLayout(editor, steps)
}

async function runElkLayout(
  editor: Editor,
  steps: { id: string }[]
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
  const originX = vp.x + vp.w / 2 - (graph.width ?? 0) / 2
  const originY = vp.y + vp.h / 4

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

// ─── Appear animation (CSS keyframe via data attribute) ───────────────────────
function scheduleAppearAnimation(editor: Editor, shapeId: TLShapeId) {
  // We rely on the CSS @keyframes `shape-appear` defined globally
  // Nothing to do here at the tldraw level — the HTMLContainer picks it up
  // via the `.tl-shape[data-shape-id]` selector in global CSS.
  void shapeId
  void editor
}
