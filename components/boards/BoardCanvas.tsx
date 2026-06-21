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
  return (
    <WhiteboardApp boardId={boardId} initialSnapshot={initialSnapshot} />
  );
}
