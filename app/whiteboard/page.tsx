'use client'

// tldraw + Tiptap are browser-only (they touch window/document at import time),
// so the whiteboard must never be server-rendered. We load it via next/dynamic
// with `ssr: false` from this Client Component boundary — the Next 16 App Router
// requires `ssr: false` to live in a Client Component, not a Server Component.
import dynamic from 'next/dynamic'

const WhiteboardApp = dynamic(
  () => import('@/components/whiteboard/WhiteboardApp'),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f8fafc',
          color: '#94a3b8',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 14,
        }}
      >
        Loading whiteboard…
      </div>
    ),
  },
)

export default function WhiteboardPage() {
  // Legacy entry point: no durable board row, so the board id == the LIVE
  // `?session=` value (or "default"). Persistence PUTs will 404 against a
  // non-existent board row and are silently swallowed — the live board still
  // works. The first-class durable path is /boards/[id] (BoardCanvas).
  const boardId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('session') ?? 'default'
      : 'default'
  return <WhiteboardApp boardId={boardId} />
}
