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
import { setEditor, connectBoardStream } from './lib/commandQueue'
import { VoiceConnect } from './VoiceConnect'
// M4 board-side Redis sync — best-effort, board still works if /api/board is down.
import { setSession, fetchBoard, reportGeometry } from './lib/boardSync'
// Client-side non-overlap guarantee. The agent proposes positions; the guard
// guarantees no two blocks overlap, reacting to creation, growth, and drags.
import { markUserMoved, noteChanged, isSuppressed, scheduleResolve } from './lib/layoutGuard'

const CUSTOM_SHAPE_UTILS = [MindMapNodeUtil, FlowNodeUtil, ExplanationCardUtil, ImageNodeUtil, MarkdownDocUtil]

interface WhiteboardAppProps {
  /** Session id used to namespace this board in Redis and the SSE stream.
   *  Defaults to the `?session=` URL param, or "default" if absent. */
  session?: string
}

function getSessionFromUrl(): string {
  if (typeof window === 'undefined') return 'default'
  return new URLSearchParams(window.location.search).get('session') ?? 'default'
}

export function WhiteboardApp({ session }: WhiteboardAppProps = {}) {
  // Derive session once (before handleMount so VoiceConnect gets the same value).
  const sess = session ?? (typeof window !== 'undefined' ? getSessionFromUrl() : 'default')

  const handleMount = useCallback((editor: Editor) => {
    setEditor(editor)

    // Connect to the same-origin SSE board stream (replaced the old WS mock server).
    // The stream is served by /api/board/stream?session=<sess> (:3000, same-origin).
    connectBoardStream(sess)

    editor.updateInstanceState({ isDebugMode: false })

    // ── M4: derive session id and initialise the sync helper ─────────────────
    setSession(sess)

    // ── M4: restore-on-mount — fetch board snapshot from Redis ───────────────
    // v1 stub: blocks are fetched and logged; full shape rehydration is a
    // TODO because deterministically re-creating tldraw shapes (including
    // flowcharts/mindmaps with their arrow bindings) from raw BlockRecord data
    // requires the same placement + binding logic as the original commandQueue
    // ops and is a significant chunk of work best done in a follow-on pass.
    // The geometry write-back path below IS fully wired and functional.
    fetchBoard(sess).then((blocks) => {
      if (blocks.length > 0) {
        console.log('[boardSync] restored', blocks.length, 'block(s) from Redis for session', sess)
        // TODO(M4-restore): iterate blocks and call commandQueue enqueue() for
        // each record's type/content to rehydrate shapes on the board.
      }
    })

    // ── M4: geometry write-back — report real post-layout bboxes to Redis ────
    // Subscribe to tldraw store changes; when shapes move/resize, report their
    // new bounding boxes. Debounced by boardSync (500 ms) so drag events coalesce.
    const unsub = editor.store.listen(
      (entry) => {
        const updates: { id: string; bbox: { x: number; y: number; w: number; h: number } }[] = []
        const movedIds: string[] = []
        for (const [, change] of Object.entries(entry.changes.updated)) {
          // change is a [prev, next] tuple — we only need the next value.
          const next = (change as [unknown, unknown])[1] as { typeName?: string; id?: string; x?: number; y?: number; props?: { w?: number; h?: number } }
          if (next?.typeName !== 'shape') continue
          const { id, x, y, props } = next
          if (typeof id !== 'string' || typeof x !== 'number' || typeof y !== 'number') continue
          const w = typeof props?.w === 'number' ? props.w : 0
          const h = typeof props?.h === 'number' ? props.h : 0
          updates.push({ id, bbox: { x, y, w, h } })
          movedIds.push(id)
        }
        if (updates.length > 0) reportGeometry(updates, sess)
        // PIN user-moved shapes so the overlap guard never fights the user —
        // their whole cluster stays put while neighbors yield around it.
        if (movedIds.length > 0) markUserMoved(movedIds)
      },
      { source: 'user', scope: 'document' }, // only track user-initiated changes
    )

    // ── Overlap guard listener (ALL sources) ─────────────────────────────────
    // Drives the client-side non-overlap guarantee. Reacts to AGENT and user
    // changes alike: when blocks are born or their real bounds change (markdown
    // growth, ELK/d3 settle, drag/resize), record the change, push real settled
    // bboxes to Redis, and schedule an overlap-resolution pass.
    const isBlock = (rec: { typeName?: string; type?: string } | undefined): boolean =>
      rec?.typeName === 'shape' && rec.type !== 'arrow'

    const unsubGuard = editor.store.listen(
      (entry) => {
        // Ignore the guard's OWN writes so it doesn't recurse.
        if (isSuppressed()) return

        const changedIds = new Set<string>()
        const geometry: { id: string; bbox: { x: number; y: number; w: number; h: number } }[] = []

        for (const rec of Object.values(entry.changes.added)) {
          const r = rec as { typeName?: string; type?: string; id?: string; x?: number; y?: number; props?: { w?: number; h?: number } }
          if (!isBlock(r) || typeof r.id !== 'string') continue
          changedIds.add(r.id)
          if (typeof r.x === 'number' && typeof r.y === 'number') {
            geometry.push({ id: r.id, bbox: { x: r.x, y: r.y, w: r.props?.w ?? 0, h: r.props?.h ?? 0 } })
          }
        }
        for (const change of Object.values(entry.changes.updated)) {
          const next = (change as [unknown, unknown])[1] as { typeName?: string; type?: string; id?: string; x?: number; y?: number; props?: { w?: number; h?: number } }
          if (!isBlock(next) || typeof next.id !== 'string') continue
          changedIds.add(next.id)
          if (typeof next.x === 'number' && typeof next.y === 'number') {
            geometry.push({ id: next.id, bbox: { x: next.x, y: next.y, w: next.props?.w ?? 0, h: next.props?.h ?? 0 } })
          }
        }
        // Removed shapes are relevant too — they free up space for the guard.
        for (const rec of Object.values(entry.changes.removed)) {
          const r = rec as { typeName?: string; type?: string; id?: string }
          if (!isBlock(r) || typeof r.id !== 'string') continue
          changedIds.add(r.id)
        }

        if (changedIds.size === 0) return

        noteChanged([...changedIds])
        if (geometry.length > 0) reportGeometry(geometry, sess)
        scheduleResolve(editor)
      },
      { scope: 'document' }, // ALL sources — agent writes included
    )

    // Return value from useCallback is ignored by tldraw; store unsubs for cleanup.
    // We attach them to the editor instance as non-reactive properties.
    ;(editor as Editor & { _boardSyncUnsub?: () => void; _layoutGuardUnsub?: () => void })._boardSyncUnsub = unsub
    ;(editor as Editor & { _boardSyncUnsub?: () => void; _layoutGuardUnsub?: () => void })._layoutGuardUnsub = unsubGuard
  }, [sess])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        shapeUtils={CUSTOM_SHAPE_UTILS}
        onMount={handleMount}
        autoFocus
      />
      {/* Floating voice connect button — talks to the pipecat agent at :7860 */}
      <VoiceConnect session={sess} />
    </div>
  )
}
