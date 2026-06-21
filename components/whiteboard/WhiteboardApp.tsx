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
// Durable Supabase persistence (snapshot truth + debounced autosave).
import { createAutosave } from './lib/persistence'
// Client-side non-overlap guarantee. The agent proposes positions; the guard
// guarantees no two blocks overlap, reacting to creation, growth, and drags.
import { markUserMoved, noteChanged, isSuppressed, scheduleResolve } from './lib/layoutGuard'

const CUSTOM_SHAPE_UTILS = [MindMapNodeUtil, FlowNodeUtil, ExplanationCardUtil, ImageNodeUtil, MarkdownDocUtil]

interface WhiteboardAppProps {
  /** Durable board id — also the LIVE `session` for Redis/SSE/geometry sync.
   *  (Board id === the existing Redis/SSE `session` value.) */
  boardId: string
  /** A tldraw snapshot to hydrate the board with on mount, or null/undefined. */
  initialSnapshot?: unknown | null
}

export default function WhiteboardApp({ boardId, initialSnapshot }: WhiteboardAppProps) {
  // The board id IS the live session — namespaces Redis, the SSE stream, and
  // the geometry write-back.
  const sess = boardId

  const handleMount = useCallback((editor: Editor) => {
    setEditor(editor)

    // ── Durable hydration ────────────────────────────────────────────────────
    // If a snapshot was passed (C's server route loads it from Supabase), load
    // it BEFORE wiring autosave so we don't immediately re-save what we just
    // hydrated. `applyingInitial` gates the autosave listener below.
    let applyingInitial = false
    if (initialSnapshot != null) {
      try {
        applyingInitial = true
        editor.loadSnapshot(initialSnapshot as Parameters<Editor['loadSnapshot']>[0])
      } catch (err) {
        console.warn('[WhiteboardApp] failed to hydrate snapshot:', (err as Error).message)
      } finally {
        applyingInitial = false
      }
    }

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

    // ── Durable autosave (debounced ~1.5s) → Supabase ────────────────────────
    // On any store change, schedule a save of the full snapshot + derived rows.
    // Skipped while the initial hydration is still applying so we don't echo it.
    const autosave = createAutosave(boardId, editor)
    const unsubAutosave = editor.store.listen(
      () => {
        if (applyingInitial) return
        autosave.schedule()
      },
      { scope: 'document' }, // persist agent AND user writes
    )

    // tldraw's onMount accepts a cleanup callback — tear down every listener and
    // cancel the autosave timer on unmount so nothing leaks across boards.
    return () => {
      unsub()
      unsubGuard()
      unsubAutosave()
      autosave.cancel()
    }
  }, [sess, boardId, initialSnapshot])

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
