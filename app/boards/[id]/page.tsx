import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BoardCanvas from "@/components/boards/BoardCanvas";

/**
 * /boards/[id] — renders a single board's canvas. The board id doubles as the
 * Redis/SSE session value. RLS scopes the row to its owner, so a board the
 * current user doesn't own simply won't be returned → notFound().
 *
 * Next 16: route `params` is a Promise and must be awaited.
 */
export default async function BoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: board, error } = await supabase
    .from("boards")
    .select("id, snapshot")
    .eq("id", id)
    .maybeSingle();

  if (error || !board) notFound();

  return <BoardCanvas boardId={board.id} initialSnapshot={board.snapshot ?? null} />;
}
