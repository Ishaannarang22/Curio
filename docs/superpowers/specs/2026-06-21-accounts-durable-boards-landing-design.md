# Curio — Accounts, Durable Boards & Story Landing — Design

Date: 2026-06-21 · Branch: `auth` · Status: approved, building

## Goal

Two shipping outcomes:

1. **Aesthetic story landing page** at `/` with a self-playing animated board demo.
2. **Accounts + durable persistence**: magic-link auth, each user owns multiple
   saved boards. Redis remains the fast live cache; **Supabase is the durable
   source of truth**. A board built by voice alone must survive a refresh.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| What we save | **Both** — `snapshot jsonb` (lossless tldraw store, the truth) **+** derived `board_nodes`/`board_edges` rows for queryability |
| Auth | **Magic link** (passwordless) via Supabase Auth + `@supabase/ssr` |
| Save trigger | **Autosave (debounced ~1.5s) + on agent write** (server flush) |
| Board UI | Story landing → `/login`/`/signup` → `/boards/[id]` app shell with left sidebar + **New board** button |

## Architecture

### Supabase project
- Project ref `rjtofejmhsogbiebaabf`, URL `https://rjtofejmhsogbiebaabf.supabase.co`.
- Fresh: Auth schema present (0 users), no public tables, no migrations yet.

### Schema (migration `init_boards`)
```
boards
  id          uuid pk default gen_random_uuid()
  owner       uuid not null references auth.users(id) on delete cascade
  title       text not null default 'Untitled board'
  snapshot    jsonb            -- full tldraw store snapshot; TRUTH, lossless
  created_at  timestamptz default now()
  updated_at  timestamptz default now()

board_nodes  -- derived from agent NodeRecord, for queryability
  id          uuid pk default gen_random_uuid()
  board_id    uuid not null references boards(id) on delete cascade
  node_id     text not null            -- semantic id (e.g. "q1_node")
  kind        text not null            -- mindMap | flow | image
  label       text
  subtitle    text
  position    jsonb
  url         text
  status      text
  updated_at  timestamptz default now()
  unique (board_id, node_id)

board_edges
  id          uuid pk default gen_random_uuid()
  board_id    uuid not null references boards(id) on delete cascade
  from_id     text not null
  to_id       text not null
  updated_at  timestamptz default now()
  unique (board_id, from_id, to_id)
```
RLS enabled on all three. Policies: `boards` rows where `owner = auth.uid()`
(select/insert/update/delete). `board_nodes`/`board_edges` gated by an EXISTS
check against the parent board's owner. `updated_at` maintained by a trigger.

### Auth
- `@supabase/ssr` cookie-based sessions. Three clients: browser
  (`lib/supabase/client.ts`), server (`lib/supabase/server.ts`, async cookies),
  and middleware (`lib/supabase/middleware.ts`).
- `middleware.ts` at repo root refreshes the session on every request and
  redirects unauthenticated `/boards/**` requests to `/login`.
- `/login` + `/signup`: email field → `signInWithOtp` magic link. Signup also
  captures a display name (stored in user metadata). `/auth/callback/route.ts`
  exchanges the code for a session, then redirects to `/boards`.
- Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable).

### Persistence flow
- **Board id = session namespace.** Opening `/boards/[id]` uses `id` as the
  existing `?session=` value for Redis + SSE. No change to the live transport.
- **Open:** server loads `boards.snapshot` from Supabase → client
  `editor.loadSnapshot()` → seed Redis (if its namespace is empty) → subscribe SSE.
- **Edit (client):** debounced ~1.5s, serialize `editor.getSnapshot()` and the
  derived node/edge set → `PUT /api/boards/[id]/snapshot` → upsert into the three
  tables. Redis is untouched as the live working copy.
- **Agent write (server):** in `app/api/board/send/route.ts`, after applying to
  Redis, throttled flush of the derived rows (and a snapshot rebuilt from board
  state) to Supabase. This covers voice-only boards with no browser edits.

### Frontend
- `/` story landing: bespoke animated scene (framer-motion, newly added) on a
  freeform dotted canvas — mind-map pills, sticky notes, self-drawing arrows, an
  image card resolving, looping. Orb black/white wireframe + glow aesthetic.
  Scroll-told sections → CTA `/signup`. Replaces the create-next-app boilerplate.
- `/boards/[id]`: left sidebar (board list · **+ New board** · user · sign out)
  + existing `WhiteboardApp` wired to the board id. New board inserts a `boards`
  row and routes to it. First sign-in with zero boards auto-creates one.

## API surface (new)
- `GET  /api/boards` — list current user's boards (id, title, updated_at).
- `POST /api/boards` — create a board, returns id.
- `PUT  /api/boards/[id]/snapshot` — upsert snapshot + derived rows (client autosave).
- `GET  /api/boards/[id]` — fetch snapshot for hydration (or via server component).

## Shared contracts (so parallel agents don't collide)
- Supabase clients live at `lib/supabase/{client,server,middleware}.ts` — Agent A
  owns these; B and C import them, never redefine them.
- Generated types at `lib/supabase/types.ts` (from `generate_typescript_types`).
- Board id is always the Redis/SSE `session` value — do not invent a second id.

## Execution (parallel sub-agents, opus/medium, partitioned by file)
- **Phase 1 (concurrent):**
  - **A** — Supabase foundation + auth: deps, `lib/supabase/*`, migrations via
    MCP, generated types, `/login` `/signup` `/auth/callback`, `middleware.ts`.
  - **D** — story landing: `app/page.tsx`, `components/landing/*`, framer-motion.
- **Phase 2 (concurrent, after A):**
  - **B** — persistence wiring: `app/api/boards/**`, client autosave hook,
    server agent-write flush, hydrate-from-snapshot.
  - **C** — app shell + sidebar: `app/boards/**`, `components/boards/Sidebar`.

Each agent commits its own work with focused messages.

## Non-goals
- No sharing/collaboration between users yet (RLS is single-owner).
- No password auth, no OAuth providers in this pass.
- No board thumbnails/previews in the sidebar (title + timestamp only).
