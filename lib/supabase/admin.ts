import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

// Server-only guard: the service role key bypasses RLS and must never ship to
// the browser. If this module is ever evaluated in a client bundle, fail loudly.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/supabase/admin.ts is server-only and must not be imported by client code",
  );
}

/**
 * Service-role Supabase client factory. **Server-only** — bypasses RLS, so it
 * must NEVER be imported by client code (see the runtime guard above).
 *
 * Used for best-effort durable writes from contexts that have no user cookie
 * (e.g. the agent → board broadcast in `/api/board/send`, where the caller is
 * the Python voice agent, not a signed-in browser).
 *
 * Gracefully returns `null` when `SUPABASE_SERVICE_ROLE_KEY` (or the URL) is
 * missing, so callers can no-op instead of crashing. Every caller MUST handle
 * the `null` case.
 */
let _client: SupabaseClient<Database> | null | undefined;

export function createServiceClient(): SupabaseClient<Database> | null {
  // Memoize across invocations in the same Node process (including the
  // resolved-null case, so we don't re-check env on every call).
  if (_client !== undefined) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    _client = null;
    return _client;
  }

  _client = createClient<Database>(url, serviceKey, {
    auth: {
      // No cookie/session handling — this is a stateless server client.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return _client;
}
