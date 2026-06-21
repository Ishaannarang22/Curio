"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type BoardListItem = {
  id: string;
  title: string;
  updated_at: string;
};

/** Short relative timestamp: "now", "5m", "3h", "2d", or a date for older. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/* ── Inline icons (currentColor, 24-grid, soft strokes) ──────────────────── */
function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconBoard() {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 9h18M9 18l-1.5 2M15 18l1.5 2" />
    </svg>
  );
}
function IconSignOut() {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}
function Spark() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8" />
    </svg>
  );
}

export default function Sidebar() {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const activeId = params?.id;

  const [boards, setBoards] = useState<BoardListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  // Bumping this token forces a list re-fetch (e.g. right after creating a board).
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // Single source of truth for loading the board list. Re-runs on mount, when
  // the active board changes, and whenever `refresh()` bumps the token. All
  // setState happens after the awaited fetch (no synchronous cascade).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/boards", { cache: "no-store" });
        if (!res.ok) throw new Error(`boards ${res.status}`);
        // GET /api/boards responds `{ boards: [{ id, title, updated_at }] }`.
        const data = (await res.json()) as { boards?: BoardListItem[] };
        if (!cancelled) setBoards(Array.isArray(data.boards) ? data.boards : []);
      } catch {
        // Leave the existing list in place on a transient failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setEmail(data.user?.email ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const createBoard = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/boards", { method: "POST" });
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { id } = (await res.json()) as { id: string };
      refresh();
      router.push(`/boards/${id}`);
    } catch {
      setCreating(false);
    }
  }, [creating, refresh, router]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }, [router]);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark">
          <Spark />
        </span>
        <span className="sidebar__brand-name">Curio</span>
      </div>

      <button
        type="button"
        className="sidebar__new"
        onClick={createBoard}
        disabled={creating}
      >
        <IconPlus />
        <span>{creating ? "Creating…" : "New board"}</span>
      </button>

      <div className="sidebar__section-label">Boards</div>

      <nav className="sidebar__list" aria-label="Your boards">
        {loading && boards.length === 0 ? (
          <div className="sidebar__empty">Loading…</div>
        ) : boards.length === 0 ? (
          <div className="sidebar__empty">No boards yet</div>
        ) : (
          boards.map((b) => {
            const isActive = b.id === activeId;
            return (
              <Link
                key={b.id}
                href={`/boards/${b.id}`}
                className={`sidebar__item${isActive ? " is-active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="sidebar__item-icon">
                  <IconBoard />
                </span>
                <span className="sidebar__item-title">
                  {b.title?.trim() || "Untitled board"}
                </span>
                <span className="sidebar__item-time">
                  {relativeTime(b.updated_at)}
                </span>
              </Link>
            );
          })
        )}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__user" title={email ?? undefined}>
          <span className="sidebar__avatar">
            {(email?.[0] ?? "?").toUpperCase()}
          </span>
          <span className="sidebar__email">{email ?? "Signed in"}</span>
        </div>
        <button
          type="button"
          className="sidebar__signout"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <IconSignOut />
        </button>
      </div>
    </aside>
  );
}
