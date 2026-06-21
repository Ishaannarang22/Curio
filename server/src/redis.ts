import 'dotenv/config' // load server/.env (REDIS_URL) before constructing clients
import Redis from 'ioredis'

// Local Docker default; override with REDIS_URL in server/.env to use Redis
// Cloud (no Docker). ioredis enables TLS automatically for rediss:// URLs.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

// Mask the password when logging the target.
const redactedUrl = REDIS_URL.replace(/(:\/\/[^:]+:)[^@]+@/, '$1****@')

// Shared connection for normal commands (HSET / HGETALL / DEL) AND PUBLISH.
// PUBLISH is allowed on a normal connection; only SUBSCRIBE puts a connection
// into the restricted "subscriber mode" where ordinary commands are rejected.
export const redis = new Redis(REDIS_URL)

// A connection in subscribe mode can't issue normal commands, so every
// subscriber needs its own dedicated connection.
export function createSubscriber(): Redis {
  return new Redis(REDIS_URL)
}

redis.on('connect', () => console.log(`[redis] connecting to ${redactedUrl}`))
redis.on('ready', () => console.log('[redis] ready'))
redis.on('error', (e) => console.error('[redis] error:', e.message))
