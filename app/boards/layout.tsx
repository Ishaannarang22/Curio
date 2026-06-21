import type { ReactNode } from "react";
import Sidebar from "@/components/boards/Sidebar";
import "@/components/boards/sidebar.css";

/**
 * Boards app shell: a fixed-width left sidebar (board list + account) and a
 * flexible main content area that hosts the tldraw canvas. The shell is the
 * full viewport; the canvas fills whatever space the sidebar leaves so tldraw
 * still gets a full-height container (it sizes to its parent via ResizeObserver).
 */
export default function BoardsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="boards-shell">
      <Sidebar />
      <main className="boards-main">{children}</main>
    </div>
  );
}
