"use client";

// tldraw + Tiptap are browser-only (they touch window/document at import time),
// so WhiteboardApp must never be server-rendered. Next 16 requires that an
// `ssr: false` dynamic import live inside a Client Component — this thin wrapper
// is that boundary. The server [id]/page.tsx fetches the board and passes the
// id + snapshot down as plain serializable props.
import dynamic from "next/dynamic";
import type { Json } from "@/lib/supabase/types";

const WhiteboardApp = dynamic(
  () => import("@/components/whiteboard/WhiteboardApp"),
  {
    ssr: false,
    loading: () => (
      <div className="board-canvas__loading">Loading whiteboard…</div>
    ),
  },
);

export default function BoardCanvas({
  boardId,
  initialSnapshot,
}: {
  boardId: string;
  initialSnapshot: Json | null;
}) {
  // `key={boardId}` is load-bearing: tldraw's `onMount` (which binds the SSE
  // session, hydrates the snapshot, wires autosave) runs ONCE per mount. Without
  // a board-scoped key, client-side navigation between boards reuses the same
  // instance, so every binding — including the voice session — stays pinned to
  // the first board. Keying by id forces a full teardown + fresh mount on switch.
  return (
    <WhiteboardApp
      key={boardId}
      boardId={boardId}
      initialSnapshot={initialSnapshot}
    />
  );
}
