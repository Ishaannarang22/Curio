import { useCallback, useEffect } from 'react'
import {
  Tldraw,
  Editor,
  DefaultToolbar,
  DefaultToolbarContent,
  TldrawUiMenuItem,
  useTools,
  useIsToolSelected,
  TLComponents,
} from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

import { MindMapNodeUtil } from '../shapes/MindMapNode'
import { FlowNodeUtil } from '../shapes/FlowNode'
import { ExplanationCardUtil } from '../shapes/ExplanationCard'
import { ImageNodeUtil } from '../shapes/ImageNode'
import { setEditor, connectWebSocket } from '../lib/commandQueue'
import { TutorPanel } from './TutorPanel'

const CUSTOM_SHAPE_UTILS = [MindMapNodeUtil, FlowNodeUtil, ExplanationCardUtil, ImageNodeUtil]

// Simplified toolbar: select, hand (pan), draw, eraser
function CustomToolbar() {
  const tools = useTools()
  const isSelectSelected = useIsToolSelected(tools['select'])
  const isHandSelected = useIsToolSelected(tools['hand'])
  const isDrawSelected = useIsToolSelected(tools['draw'])
  const isEraserSelected = useIsToolSelected(tools['eraser'])

  return (
    <DefaultToolbar>
      <TldrawUiMenuItem {...tools['select']} isSelected={isSelectSelected} />
      <TldrawUiMenuItem {...tools['hand']} isSelected={isHandSelected} />
      <TldrawUiMenuItem {...tools['draw']} isSelected={isDrawSelected} />
      <TldrawUiMenuItem {...tools['eraser']} isSelected={isEraserSelected} />
      <DefaultToolbarContent />
    </DefaultToolbar>
  )
}

const components: TLComponents = {
  Toolbar: CustomToolbar,
}

export function WhiteboardApp() {
  const handleMount = useCallback((editor: Editor) => {
    setEditor(editor)
    connectWebSocket('ws://localhost:8080')

    // Dark-ish background
    editor.updateInstanceState({ isDebugMode: false })
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        shapeUtils={CUSTOM_SHAPE_UTILS}
        components={components}
        onMount={handleMount}
        autoFocus
      />
      <TutorPanel />
    </div>
  )
}
