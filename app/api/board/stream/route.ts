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
// Keep the SSE stream open as long as the platform allows; EventSource
// auto-reconnects after the cap.
export const maxDuration = 300

import { NextRequest } from 'next/server'
import { addController } from '../_registry'
import { channelFor, createSubscriber, redisEnabled } from '../redisBus'
import type Redis from 'ioredis'

const HEARTBEAT_MS = 15_000

export async function GET(req: NextRequest) {
  const session =
    req.nextUrl.searchParams.get('session')?.trim() || 'default'

  const encoder = new TextEncoder()

  let heartbeatId: ReturnType<typeof setInterval> | null = null
  let subscriber: Redis | null = null

  const cleanup = () => {
    if (heartbeatId) clearInterval(heartbeatId)
    heartbeatId = null
    if (subscriber) {
      subscriber.quit().catch(() => subscriber?.disconnect())
      subscriber = null
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      // Initial SSE comment so the browser knows the connection is live.
      ctrl.enqueue(encoder.encode(`: connected session=${session}\n\n`))

      if (redisEnabled()) {
        // Cross-instance transport: subscribe to this session's Redis channel
        // and forward every published command to the browser.
        subscriber = createSubscriber()
        if (subscriber) {
          subscriber.on('message', (_channel, message) => {
            try {
              ctrl.enqueue(encoder.encode(`data: ${message}\n\n`))
            } catch {
              cleanup()
            }
          })
          try {
            await subscriber.subscribe(channelFor(session))
          } catch (err) {
            console.error('[board/stream] subscribe failed:', (err as Error).message)
          }
        }
      } else {
        // Pure-local dev fallback: same-process in-memory registry.
        addController(session, ctrl)
      }

      // Periodic heartbeat to keep the connection alive through proxies.
      heartbeatId = setInterval(() => {
        try {
          ctrl.enqueue(encoder.encode(`: heartbeat\n\n`))
        } catch {
          cleanup()
        }
      }, HEARTBEAT_MS)
    },

    cancel() {
      // Browser closed/navigated away — release the Redis subscriber.
      cleanup()
    },
  })

  // Also clean up on request abort (navigation, refresh).
  req.signal.addEventListener('abort', cleanup)

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  })
}
