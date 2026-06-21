import { Editor } from '@tldraw/tldraw'
import * as api from './boardApi'
import { installSafeShapeWrites } from './safeShapeWrites'

type Command = {
  action: string
  payload: Record<string, unknown>
}

const MAX_MESSAGE_BYTES = 128 * 1024
const MAX_TEXT_CHARS = 64 * 1024
const MAX_LABEL_CHARS = 500
const MAX_ITEMS = 100
const VALID_ID = /^[\w\-:.]{1,128}$/
const ALLOWED_ACTIONS = new Set([
  'addNote',
  'addExplanation',
  'appendToExplanation',
  'addMarkdown',
  'appendMarkdown',
  'addFlowNode',
  'addMindMapNode',
  'connectNodes',
  'updateNode',
  'removeNode',
  'addMindMap',
  'addFlowchart',
  'requestImage',
  'resolveImage',
  'highlightNode',
  'moveShape',
  'clearBoard',
])

// ─── Sequential command queue ─────────────────────────────────────────────────
const queue: Command[] = []
let running = false
let editorRef: Editor | null = null

export function setEditor(editor: Editor) {
  // Single choke point: make every board write prop-safe so a stray prop (e.g.
  // an LLM tool call passing `highlighted`/`text` to a built-in note) degrades
  // gracefully instead of throwing and killing the command queue.
  installSafeShapeWrites(editor)
  editorRef = editor
}

export function enqueue(cmd: unknown) {
  if (!isValidCommand(cmd)) {
    console.warn('[commandQueue] Rejected invalid command')
    return
  }
  queue.push(cmd)
  if (!running) drain()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && VALID_ID.test(value)
}

function isString(value: unknown, max = MAX_TEXT_CHARS): value is string {
  return typeof value === 'string' && value.length <= max
}

function isPosition(value: unknown): value is { x: number; y: number } {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return Number.isFinite(value.x) && Number.isFinite(value.y)
}

function isHttpsUrl(value: unknown): value is string {
  if (!isString(value, 2048)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (location.hostname === 'localhost' && url.protocol === 'http:')
  } catch {
    return false
  }
}

function isValidCommand(cmd: unknown): cmd is Command {
  if (!isRecord(cmd) || !isString(cmd.action, 64) || !ALLOWED_ACTIONS.has(cmd.action)) return false
  if (!isRecord(cmd.payload)) return false
  const p = cmd.payload

  switch (cmd.action) {
    case 'addNote':
      // id is optional (add_sticky supplies it; legacy callers omit it)
      return isString(p.text) && isPosition(p.position) && (p.id === undefined || isId(p.id))
    case 'appendMarkdown':
      return isId(p.id) && isString(p.markdown)
    case 'moveShape':
      return isId(p.id) && Number.isFinite(p.x) && Number.isFinite(p.y)
    case 'addExplanation':
      return isId(p.id) && isString(p.text) && isPosition(p.position)
    case 'appendToExplanation':
      return isId(p.id) && isString(p.moreText)
    case 'addMarkdown':
      return (p.id === undefined || isId(p.id)) && isString(p.markdown) && isPosition(p.position)
    case 'addFlowNode':
      return isId(p.id) && isString(p.label, MAX_LABEL_CHARS) && isPosition(p.position)
    case 'addMindMapNode':
      return isId(p.id) && isString(p.label, MAX_LABEL_CHARS) && (p.parentId === undefined || isId(p.parentId)) && isPosition(p.position)
    case 'connectNodes':
      return isId(p.fromId) && isId(p.toId) && (p.label === undefined || isString(p.label, MAX_LABEL_CHARS))
    case 'updateNode':
      return isId(p.id) && isString(p.newLabel, MAX_LABEL_CHARS)
    case 'removeNode':
    case 'highlightNode':
      return isId(p.id)
    case 'addMindMap':
      return isId(p.id) && isString(p.centerLabel, MAX_LABEL_CHARS) && Array.isArray(p.branches) && p.branches.length <= MAX_ITEMS && p.branches.every((b) => isRecord(b) && isId(b.id) && isString(b.label, MAX_LABEL_CHARS)) && isPosition(p.position)
    case 'addFlowchart':
      return isId(p.id) && Array.isArray(p.steps) && p.steps.length <= MAX_ITEMS && p.steps.every((s) => isRecord(s) && isId(s.id) && isString(s.label, MAX_LABEL_CHARS) && (s.subtitle === undefined || isString(s.subtitle, MAX_LABEL_CHARS))) && isPosition(p.position)
    case 'requestImage':
      return isId(p.id) && isString(p.prompt, MAX_LABEL_CHARS) && isPosition(p.position)
    case 'resolveImage':
      return isId(p.id) && isHttpsUrl(p.url)
    case 'clearBoard':
      return true
    default:
      return false
  }
}

async function drain() {
  running = true
  while (queue.length > 0) {
    const cmd = queue.shift()!
    await execute(cmd)
  }
  running = false
}

async function execute(cmd: Command) {
  const editor = editorRef
  if (!editor) return
  const p = cmd.payload

  try {
    switch (cmd.action) {
      case 'addNote':
        // Thread optional id through so add_sticky blocks are idMap-addressable.
        api.addNote(editor, p.text as string, p.position as { x: number; y: number } | undefined, p.color as string | undefined, p.id as string | undefined)
        await sleep(250)
        break

      case 'appendMarkdown':
        api.appendMarkdown(editor, p.id as string, p.markdown as string)
        await sleep(150)
        break

      case 'moveShape':
        api.moveShape(editor, p.id as string, p.x as number, p.y as number)
        await sleep(350) // slightly longer than the 300ms animation
        break

      case 'addExplanation':
        api.addExplanation(editor, p.id as string, p.text as string, p.position as { x: number; y: number } | undefined)
        // Wait for typewriter to finish: approx duration
        await sleep(Math.min(900, Math.max(600, (p.text as string).length * 18)) + 100)
        break

      case 'appendToExplanation':
        api.appendToExplanation(editor, p.id as string, p.moreText as string)
        await sleep(Math.min(900, Math.max(600, (p.moreText as string).length * 18)) + 100)
        break

      case 'addMarkdown':
        api.addMarkdown(editor, p.markdown as string, {
          id: p.id as string | undefined,
          position: p.position as { x: number; y: number } | undefined,
          size: p.size as { w?: number; h?: number } | undefined,
        })
        await sleep(250)
        break

      case 'addFlowNode':
        api.addFlowNode(editor, p.id as string, p.label as string, p.subtitle as string | undefined, p.position as { x: number; y: number } | undefined)
        await sleep(250)
        break

      case 'addMindMapNode':
        api.addMindMapNode(editor, p.id as string, p.label as string, p.parentId as string | undefined, p.position as { x: number; y: number } | undefined)
        await sleep(250)
        break

      case 'connectNodes':
        api.connectNodes(editor, p.fromId as string, p.toId as string, p.label as string | undefined)
        await sleep(150)
        break

      case 'updateNode':
        api.updateNode(editor, p.id as string, p.newLabel as string)
        await sleep(150)
        break

      case 'removeNode':
        api.removeNode(editor, p.id as string)
        await sleep(150)
        break

      case 'addMindMap':
        await api.addMindMap(editor, p.id as string, p.centerLabel as string, p.branches as { id: string; label: string }[], p.position as { x: number; y: number } | undefined)
        break

      case 'addFlowchart':
        await api.addFlowchart(editor, p.steps as { id: string; label: string; subtitle?: string }[], p.position as { x: number; y: number } | undefined)
        break

      case 'requestImage':
        api.requestImage(editor, p.id as string, p.prompt as string, p.position as { x: number; y: number } | undefined)
        await sleep(250)
        break

      case 'resolveImage':
        api.resolveImage(editor, p.id as string, p.url as string)
        await sleep(600) // cross-fade duration
        break

      case 'highlightNode':
        await api.highlightNode(editor, p.id as string)
        break

      case 'clearBoard':
        api.clearBoard(editor)
        await sleep(200)
        break

      default:
        console.warn('[commandQueue] Unknown action:', cmd.action)
    }
  } catch (err) {
    console.error('[commandQueue] Error executing', cmd.action, err)
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

// ─── SSE transport (replaces the old WebSocket client) ───────────────────────
let sseSource: EventSource | null = null
let currentSession: string | null = null

/**
 * Connect to the board SSE stream for a given session.
 * Same-origin call to /api/board/stream?session=<session>.
 * EventSource handles auto-reconnect natively.
 *
 * Idempotent: calling again with the same session is a no-op.
 * Calling with a different session tears down the old connection first.
 */
export function connectBoardStream(session = 'default') {
  if (sseSource && currentSession === session) {
    // Already connected to this session — no-op (guards React StrictMode double-mount).
    return
  }

  // Tear down any previous connection.
  disconnectBoardStream()

  currentSession = session
  const url = `/api/board/stream?session=${encodeURIComponent(session)}`

  sseSource = new EventSource(url)

  sseSource.onopen = () => {
    console.log(`[boardStream] Connected  session=${session}`)
  }

  sseSource.onmessage = (event) => {
    try {
      const raw: string = event.data
      if (!raw || raw.length > MAX_MESSAGE_BYTES) {
        console.warn('[boardStream] Rejected oversized message')
        return
      }
      const cmd: Command = JSON.parse(raw)
      enqueue(cmd)
    } catch (e) {
      console.error('[boardStream] Bad message', e)
    }
  }

  sseSource.onerror = () => {
    // EventSource re-establishes the connection automatically after a brief
    // back-off; we just log the transient error here.
    console.warn('[boardStream] Connection error — EventSource will retry')
  }
}

export function disconnectBoardStream() {
  sseSource?.close()
  sseSource = null
  currentSession = null
}

// ─── Backward-compatible alias ────────────────────────────────────────────────
/** @deprecated Use connectBoardStream() instead. */
export function connectWebSocket(_url?: string) {
  // No-op: kept so any import that still references connectWebSocket compiles.
  // WhiteboardApp.tsx has been updated to call connectBoardStream directly.
  console.warn('[commandQueue] connectWebSocket() is deprecated — use connectBoardStream()')
}

/** @deprecated Use disconnectBoardStream() instead. */
export function disconnectWebSocket() {
  disconnectBoardStream()
}
