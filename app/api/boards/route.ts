/**
 * /api/boards
 *
 *   GET  → list the current user's boards: [{ id, title, updated_at }]
 *   POST → create a new board owned by the current user → { id }
 *
 * RLS scopes every query to `auth.uid()`, so the user can only ever see/create
 * their own boards. Returns 401 when there is no signed-in user.
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const DEFAULT_TITLE = 'Untitled board'
const MAX_TITLE_CHARS = 200

export async function GET() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('boards')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('[api/boards] list error:', error.message)
    return NextResponse.json({ error: 'failed to list boards' }, { status: 500 })
  }

  return NextResponse.json({ boards: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Optional title in the body; default if absent/invalid.
  let title = DEFAULT_TITLE
  try {
    const body = await req.json()
    if (
      body &&
      typeof body === 'object' &&
      typeof (body as { title?: unknown }).title === 'string'
    ) {
      const t = (body as { title: string }).title.trim().slice(0, MAX_TITLE_CHARS)
      if (t.length > 0) title = t
    }
  } catch {
    // No / invalid body — keep the default title.
  }

  const { data, error } = await supabase
    .from('boards')
    .insert({ owner: user.id, title })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[api/boards] create error:', error?.message)
    return NextResponse.json({ error: 'failed to create board' }, { status: 500 })
  }

  return NextResponse.json({ id: data.id }, { status: 201 })
}
