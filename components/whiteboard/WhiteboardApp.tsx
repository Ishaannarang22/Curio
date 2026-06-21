'use client'

import { useCallback } from 'react'
import { Tldraw, Editor } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'
// Notion-style fonts (self-hosted, no network at runtime) + slash/bubble popups.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import 'tippy.js/dist/tippy.css'
import './whiteboard.css'

import { MindMapNodeUtil } from './shapes/MindMapNode'
import { FlowNodeUtil } from './shapes/FlowNode'
import { ExplanationCardUtil } from './shapes/ExplanationCard'
import { ImageNodeUtil } from './shapes/ImageNode'
import { MarkdownDocUtil } from './shapes/MarkdownDoc'
import { setEditor, connectWebSocket } from './lib/commandQueue'

const CUSTOM_SHAPE_UTILS = [MindMapNodeUtil, FlowNodeUtil, ExplanationCardUtil, ImageNodeUtil, MarkdownDocUtil]

// Choose the live source. Default: the legacy mock-server on :8080. When a
// ?session=<id> query param is present, connect to the Redis relay instead at
// ws://localhost:8090/<id>, so board state is persisted/synced through Redis
// (see /server). Override the relay base with NEXT_PUBLIC_RELAY_URL.
function resolveBoardSocketUrl(): string {
  const session = new URLSearchParams(window.location.search).get('session')
  if (!session) return 'ws://localhost:8080'
  const base = process.env.NEXT_PUBLIC_RELAY_URL ?? 'ws://localhost:8090'
  return `${base}/${encodeURIComponent(session)}`
}

export function WhiteboardApp() {
  const handleMount = useCallback((editor: Editor) => {
    setEditor(editor)
    connectWebSocket(resolveBoardSocketUrl())
    editor.updateInstanceState({ isDebugMode: false })
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        shapeUtils={CUSTOM_SHAPE_UTILS}
        onMount={handleMount}
        autoFocus
      />
    </div>
  )
}
