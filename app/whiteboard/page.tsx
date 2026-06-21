'use client'

// tldraw + Tiptap are browser-only (they touch window/document at import time),
// so the whiteboard must never be server-rendered. We load it via next/dynamic
// with `ssr: false` from this Client Component boundary — the Next 16 App Router
// requires `ssr: false` to live in a Client Component, not a Server Component.
import dynamic from 'next/dynamic'

const WhiteboardApp = dynamic(
  () => import('@/components/whiteboard/WhiteboardApp').then((m) => m.WhiteboardApp),
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
  return <WhiteboardApp />
}
