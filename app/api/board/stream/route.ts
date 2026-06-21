/**
 * GET /api/board/stream?session=<id>
 *
 * Server-Sent Events endpoint. Registers the browser as a subscriber and
 * streams board commands as they arrive from /api/board/send.
 *
 * Each event: `data: {"action":"...","payload":{...}}\n\n`
 *
 * The browser's EventSource auto-reconnects on drop.
 * A 15-second heartbeat (SSE comment) keeps the connection alive through
 * proxies and load balancers.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { addController, removeController } from '../_registry'

const HEARTBEAT_MS = 15_000

export async function GET(req: NextRequest) {
  const session =
    req.nextUrl.searchParams.get('session')?.trim() || 'default'

  const encoder = new TextEncoder()

  let heartbeatId: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      // Register this subscriber.
      addController(session, ctrl)

      // Initial SSE comment so the browser knows the connection is live.
      ctrl.enqueue(encoder.encode(`: connected session=${session}\n\n`))

      // Periodic heartbeat to keep the connection alive.
      heartbeatId = setInterval(() => {
        try {
          ctrl.enqueue(encoder.encode(`: heartbeat\n\n`))
        } catch {
          // Stream already closed.
          if (heartbeatId) clearInterval(heartbeatId)
        }
      }, HEARTBEAT_MS)
    },

    cancel() {
      // Browser closed/navigated away — clean up.
      if (heartbeatId) clearInterval(heartbeatId)
      // We don't have a reference to ctrl here, but the registry cleans up
      // stale controllers on the next broadcast attempt. Explicitly remove
      // by re-deriving: Next.js closes the stream, so any enqueue will throw,
      // and broadcast() already handles that by deleting the controller.
    },
  })

  // Also clean up on request abort (navigation, refresh).
  req.signal.addEventListener('abort', () => {
    if (heartbeatId) clearInterval(heartbeatId)
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  })
}
