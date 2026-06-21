import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// The Supabase server client reads/writes cookies, so this must run on Node.js
// (not the Edge runtime) and never be statically cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Magic-link / OTP callback. `signInWithOtp` with `emailRedirectTo` uses the
 * PKCE code flow, so the email link lands here with a `?code=...`. We exchange
 * that code for a session (writing the auth cookies via the server client) and
 * then redirect to the sanitized `next` destination (default `/boards`).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const errorDescription =
    searchParams.get("error_description") ?? searchParams.get("error");

  // Only allow same-origin, relative redirect targets to avoid open redirects.
  const next = sanitizeNext(searchParams.get("next"));

  // Provider bounced the link back with an error (expired, denied, etc.).
  if (errorDescription) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorDescription)}`, origin),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=Missing+auth+code", origin),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, origin),
    );
  }

  return NextResponse.redirect(new URL(next, origin));
}

/** Force `next` to a same-origin absolute path; fall back to `/boards`. */
function sanitizeNext(raw: string | null): string {
  if (!raw) return "/boards";
  // Must be a relative path starting with a single "/" (reject "//evil.com"
  // protocol-relative URLs and any scheme like "http:").
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/boards";
  return raw;
}
