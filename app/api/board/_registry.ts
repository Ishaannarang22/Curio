/**
 * Shared in-memory SSE subscriber registry.
 *
 * Both /api/board/send and /api/board/stream import from here. Because Next.js
 * dev runs as a single Node process, a module-level Map persists across route
 * handler invocations and gives us synchronous fan-out with zero infrastructure.
 *
 * Keys: session string (e.g. "default", a UUID)
 * Values: Set of ReadableStreamDefaultController<Uint8Array>
 */

type Controller = ReadableStreamDefaultController<Uint8Array>

// Module-level singleton — survives across requests in the same Node process.
const registry = new Map<string, Set<Controller>>()

export function addController(session: string, ctrl: Controller): void {
  if (!registry.has(session)) registry.set(session, new Set())
  registry.get(session)!.add(ctrl)
}

export function removeController(session: string, ctrl: Controller): void {
  registry.get(session)?.delete(ctrl)
}

/**
 * Broadcast a command object to all SSE subscribers for a session.
 * Returns the number of subscribers that received the message.
 */
export function broadcast(
  session: string,
  cmd: { action: string; payload: Record<string, unknown> },
): number {
  const controllers = registry.get(session)
  if (!controllers || controllers.size === 0) return 0

  const data = `data: ${JSON.stringify(cmd)}\n\n`
  const encoded = new TextEncoder().encode(data)

  let sent = 0
  for (const ctrl of controllers) {
    try {
      ctrl.enqueue(encoded)
      sent++
    } catch {
      // Controller may have already closed; remove it.
      controllers.delete(ctrl)
    }
  }
  return sent
}

export function getControllers(session: string): Set<Controller> {
  return registry.get(session) ?? new Set()
}
