import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next 16 renamed the `middleware` file convention to `proxy` (middleware is
 * deprecated — see node_modules/next/dist/docs/01-app/.../proxy.md). This is the
 * single proxy entry point: it refreshes the Supabase session on every matched
 * request and gates `/boards/**` (the helper redirects unauthenticated users to
 * `/login`). It MUST return the response `updateSession` produced so the
 * refreshed auth cookies are written back.
 */
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every request path EXCEPT:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon)
     * - common image/asset extensions
     * The auth callback and login/signup pages still pass through so the session
     * can be refreshed there too.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif)$).*)",
  ],
};
