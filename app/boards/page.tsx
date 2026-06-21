import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * /boards entry. Resolves the signed-in user's "current" board:
 *  - most-recently-updated board they own, or
 *  - a freshly created empty board if they have none.
 * Then redirects to /boards/[id]. Middleware already guards unauthenticated
 * access to /boards/**, but we re-check the user here defensively.
 */
export default async function BoardsIndexPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Most-recently-updated board this user owns (RLS scopes to owner already).
  const { data: existing } = await supabase
    .from("boards")
    .select("id")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) redirect(`/boards/${existing.id}`);

  // No boards yet — create the first one and land on it.
  const { data: created, error } = await supabase
    .from("boards")
    .insert({ owner: user.id, title: "Untitled board" })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(error?.message ?? "Failed to create your first board");
  }

  redirect(`/boards/${created.id}`);
}
