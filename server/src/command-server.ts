// Test/simulation HTTP endpoint. Stands in for "an agent" until a real one
// exists: POST a { action, payload } and it runs the matching board-state
// mutation (persist + publish), which flows out through the relay to clients.
import express, { type Express } from 'express'
import { applyCommand, getFullBoardState } from './board-state'

export function createCommandApp(): Express {
  const app = express()
  app.use(express.json())

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'curio command server',
      usage: 'POST /command/:sessionId  { action, payload }',
    })
  })

  // The simulation seam. Example:
  //   curl -X POST localhost:8091/command/demo \
  //     -H 'content-type: application/json' \
  //     -d '{"action":"addMindMapNode","payload":{"id":"a","label":"Hello"}}'
  app.post('/command/:sessionId', async (req, res) => {
    const { sessionId } = req.params
    const { action, payload } = req.body ?? {}
    if (typeof action !== 'string') {
      res.status(400).json({ error: 'body must be { action: string, payload?: object }' })
      return
    }
    try {
      await applyCommand(sessionId, { action, payload: payload ?? {} })
      res.json({ ok: true })
    } catch (err) {
      console.error('[command] failed:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  // Handy for debugging: see exactly what a client would hydrate with.
  app.get('/state/:sessionId', async (req, res) => {
    res.json(await getFullBoardState(req.params.sessionId))
  })

  return app
}
