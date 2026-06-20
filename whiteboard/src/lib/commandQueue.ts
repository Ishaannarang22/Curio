import { Editor } from '@tldraw/tldraw'
import * as api from './boardApi'

type Command = {
  action: string
  payload: Record<string, unknown>
}

// ─── Sequential command queue ─────────────────────────────────────────────────
let queue: Command[] = []
let running = false
let editorRef: Editor | null = null

export function setEditor(editor: Editor) {
  editorRef = editor
}

export function enqueue(cmd: Command) {
  queue.push(cmd)
  if (!running) drain()
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
        api.addNote(editor, p.text as string, p.position as { x: number; y: number } | undefined, p.color as string | undefined)
        await sleep(250)
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
        await api.addMindMap(editor, p.centerLabel as string, p.branches as { id: string; label: string }[])
        break

      case 'addFlowchart':
        await api.addFlowchart(editor, p.steps as { id: string; label: string; subtitle?: string }[])
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

// ─── WebSocket client ─────────────────────────────────────────────────────────
let ws: WebSocket | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

export function connectWebSocket(url = 'ws://localhost:8080') {
  if (ws) ws.close()

  ws = new WebSocket(url)

  ws.onopen = () => {
    console.log('[WS] Connected to', url)
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null }
  }

  ws.onmessage = (event) => {
    try {
      const cmd: Command = JSON.parse(event.data as string)
      enqueue(cmd)
    } catch (e) {
      console.error('[WS] Bad message', e)
    }
  }

  ws.onclose = () => {
    console.warn('[WS] Disconnected. Reconnecting in 3s…')
    reconnectTimeout = setTimeout(() => connectWebSocket(url), 3000)
  }

  ws.onerror = (e) => {
    console.error('[WS] Error', e)
    ws?.close()
  }
}

export function disconnectWebSocket() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  ws?.close()
  ws = null
}
