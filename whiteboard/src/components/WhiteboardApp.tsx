import { useCallback } from 'react'
import { Tldraw, Editor } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

import { MindMapNodeUtil } from '../shapes/MindMapNode'
import { FlowNodeUtil } from '../shapes/FlowNode'
import { ExplanationCardUtil } from '../shapes/ExplanationCard'
import { ImageNodeUtil } from '../shapes/ImageNode'
import { MarkdownDocUtil } from '../shapes/MarkdownDoc'
import { setEditor, connectWebSocket } from '../lib/commandQueue'
import { TutorPanel } from './TutorPanel'

const CUSTOM_SHAPE_UTILS = [MindMapNodeUtil, FlowNodeUtil, ExplanationCardUtil, ImageNodeUtil, MarkdownDocUtil]

export function WhiteboardApp() {
  const handleMount = useCallback((editor: Editor) => {
    setEditor(editor)
    connectWebSocket('ws://localhost:8080')
    editor.updateInstanceState({ isDebugMode: false })
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        shapeUtils={CUSTOM_SHAPE_UTILS}
        onMount={handleMount}
        autoFocus
      />
      <TutorPanel />
    </div>
  )
}
