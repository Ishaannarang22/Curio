// Scripted "fake agent": fires a short sequence of commands at the command
// server so you can watch the board build live (and then refresh to prove it
// reloads from Redis). Run: npm run simulate  [sessionId]
import type { Command } from './types'

const BASE = process.env.COMMAND_URL ?? 'http://localhost:8091'
const SESSION = process.argv[2] ?? 'demo'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fire(action: string, payload: Command['payload'] = {}): Promise<void> {
  const res = await fetch(`${BASE}/command/${SESSION}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  })
  if (!res.ok) console.error(`  ✗ ${action}: ${res.status} ${await res.text()}`)
  else console.log(`  → ${action}  ${JSON.stringify(payload)}`)
}

async function main(): Promise<void> {
  console.log(`Simulating against ${BASE} (session="${SESSION}")…`)

  await fire('clearBoard')
  await sleep(400)

  // A small mind map: a center with three children (parentId auto-connects).
  await fire('addMindMapNode', { id: 'root', label: 'Photosynthesis', position: { x: 320, y: 240 } })
  await sleep(700)
  await fire('addMindMapNode', { id: 'light', label: 'Light reactions', parentId: 'root', position: { x: 120, y: 120 } })
  await sleep(700)
  await fire('addMindMapNode', { id: 'calvin', label: 'Calvin cycle', parentId: 'root', position: { x: 540, y: 120 } })
  await sleep(700)
  await fire('addMindMapNode', { id: 'chloro', label: 'Chloroplast', parentId: 'root', position: { x: 320, y: 440 } })
  await sleep(700)

  // An extra explicit edge between two children (stored in the edges hash).
  await fire('connectNodes', { fromId: 'light', toId: 'calvin', label: 'ATP / NADPH' })
  await sleep(800)

  // Rename a node (patches the stored record, so the new label survives refresh).
  await fire('updateNode', { id: 'light', newLabel: 'Light-dependent reactions' })
  await sleep(900)

  // Image: request (loading shimmer) → resolve (cross-fade to the real image).
  await fire('requestImage', { id: 'cell', prompt: 'Labeled plant cell diagram', position: { x: 720, y: 300 } })
  await sleep(1600)
  await fire('resolveImage', {
    id: 'cell',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Labeled_plant_cell_diagram.svg/640px-Labeled_plant_cell_diagram.svg.png',
  })
  await sleep(900)

  // A transient highlight pulse (published only — never persisted).
  await fire('highlightNode', { id: 'calvin' })

  console.log('\nDone. Now refresh the browser — the board should reload from Redis,')
  console.log('minus the highlight pulse (that one is ephemeral by design).')
}

main().catch((e) => {
  console.error('simulate failed:', e)
  process.exit(1)
})
