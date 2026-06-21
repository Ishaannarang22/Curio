/**
 * Redis pub/sub bus for board commands.
 *
 * The in-memory _registry only works within a single Node process. On Vercel,
 * /api/board/send and /api/board/stream run on independent function instances,
 * so an in-memory broadcast never reaches the browser. This bus fans commands
 * out through Redis Pub/Sub instead, which works across instances (and in a
 * single local process too).
 *
 * When REDIS_URL is absent we report disabled and callers fall back to the
 * in-memory registry, so pure-local dev still works with zero infrastructure.
 */

import Redis, { type RedisOptions } from 'ioredis'

export function redisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL)
}

export function channelFor(session: string): string {
  return `board:events:${session}`
}

// Shared options. family:4 avoids broken-IPv6 hosts (Redis Cloud is IPv4);
// enableOfflineQueue lets commands wait for a cold connection instead of
// failing instantly (the old 503 cause).
const baseOptions: RedisOptions = {
  family: 4,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 2,
  connectTimeout: 10_000,
}

// ─── Publisher (shared singleton — a normal client can publish) ───────────────
let _publisher: Redis | null = null

export function getPublisher(): Redis | null {
  if (!redisEnabled()) return null
  if (_publisher) return _publisher
  _publisher = new Redis(process.env.REDIS_URL!, baseOptions)
  _publisher.on('error', (err) => console.error('[board/bus] publisher error:', err.message))
  return _publisher
}

export async function publishCommand(
  session: string,
  cmd: { action: string; payload: Record<string, unknown> },
): Promise<number> {
  const pub = getPublisher()
  if (!pub) return 0
  return pub.publish(channelFor(session), JSON.stringify(cmd))
}

// ─── Subscriber (one dedicated connection per SSE stream) ─────────────────────
// A subscribed ioredis client can't issue other commands, so each open SSE
// stream owns its own connection and quits it on disconnect.
export function createSubscriber(): Redis | null {
  if (!redisEnabled()) return null
  const sub = new Redis(process.env.REDIS_URL!, baseOptions)
  sub.on('error', (err) => console.error('[board/bus] subscriber error:', err.message))
  return sub
}
