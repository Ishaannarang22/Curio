"use client";

// Client-only boundary for the whiteboard. tldraw, TipTap, and the live
// WebSocket bridge all touch browser APIs at module load, so we load the board
// with `ssr: false` (the official Next "Vite migration" client-only pattern).
import dynamic from "next/dynamic";

// Notion-style fonts (self-hosted, no network at runtime) + tldraw/tippy CSS +
// the board's own styles. Imported here so Next scopes them to the /whiteboard
// route instead of leaking globals (e.g. `overflow: hidden`) onto every page.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@tldraw/tldraw/tldraw.css";
import "tippy.js/dist/tippy.css";
import "@/board/index.css";

const WhiteboardApp = dynamic(
  () => import("@/board/components/WhiteboardApp").then((m) => m.WhiteboardApp),
  {
    ssr: false,
    loading: () => (
      <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", fontFamily: "Inter, system-ui, sans-serif", color: "#666" }}>
        Loading whiteboard…
      </div>
    ),
  }
);

export function WhiteboardClient() {
  return <WhiteboardApp />;
}
