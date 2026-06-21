/**
 * mock-server.js  —  WebSocket test server for the Curio whiteboard
 *
 * Run:  node mock-server.js
 * Then open http://localhost:8081 in a browser to fire commands manually.
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'

const WS_PORT = 8080
const HTTP_PORT = 8081

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT })
const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)
  console.log(`[WS] Client connected  (total: ${clients.size})`)
  ws.on('close', () => { clients.delete(ws); console.log(`[WS] Client disconnected`) })
})

function broadcast(cmd) {
  const msg = JSON.stringify(cmd)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg)
  }
  console.log('[SEND]', msg)
}

// ─── Sample command sequences ─────────────────────────────────────────────────
const SEQUENCES = {
  mindmap: [
    { action: 'clearBoard', payload: {} },
    {
      action: 'addMindMap',
      payload: {
        centerLabel: 'Photosynthesis',
        branches: [
          { id: 'mm1', label: 'Light Reactions' },
          { id: 'mm2', label: 'Calvin Cycle' },
          { id: 'mm3', label: 'Chloroplast' },
          { id: 'mm4', label: 'Glucose Output' },
          { id: 'mm5', label: 'O₂ Release' },
        ],
      },
    },
  ],

  flowchart: [
    { action: 'clearBoard', payload: {} },
    {
      action: 'addFlowchart',
      payload: {
        steps: [
          { id: 'f1', label: 'Student asks question', subtitle: 'Voice input' },
          { id: 'f2', label: 'STT transcription', subtitle: 'Deepgram' },
          { id: 'f3', label: 'Tutor Agent', subtitle: 'Understands intent' },
          { id: 'f4', label: 'Knowledge Agent', subtitle: 'Retrieves facts' },
          { id: 'f5', label: 'Visual Agent', subtitle: 'Renders to board' },
          { id: 'f6', label: 'TTS response', subtitle: 'ElevenLabs' },
        ],
      },
    },
  ],

  explanation: [
    { action: 'clearBoard', payload: {} },
    {
      action: 'addExplanation',
      payload: {
        id: 'exp1',
        text: '**Mitosis** is cell division that produces two identical daughter cells.\n\n- Phase 1: Prophase — chromosomes condense\n- Phase 2: Metaphase — align at center\n- Phase 3: Anaphase — sister chromatids separate\n- Phase 4: Telophase — two nuclei form',
        position: { x: 100, y: 100 },
      },
    },
    {
      action: 'appendToExplanation',
      payload: {
        id: 'exp1',
        moreText: '\n**Key fact:** Mitosis preserves the diploid chromosome number (2n).',
      },
    },
  ],

  markdown: [
    { action: 'clearBoard', payload: {} },
    {
      action: 'addMarkdown',
      payload: {
        id: 'md1',
        markdown: [
          '# Photosynthesis',
          '',
          'Plants convert **light energy** into _chemical energy_ stored as glucose.',
          '',
          '## The two stages',
          '',
          '1. **Light reactions** — in the thylakoid membrane',
          '2. **Calvin cycle** — in the stroma',
          '',
          '> Net equation: `6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂`',
          '',
          '### Inputs vs. outputs',
          '',
          '| Inputs | Outputs |',
          '| --- | --- |',
          '| Carbon dioxide | Glucose |',
          '| Water | Oxygen |',
          '| Light | — |',
          '',
          '### Checklist',
          '',
          '- [x] Absorb light',
          '- [x] Split water',
          '- [ ] Fix carbon',
          '',
          '```python',
          'def photosynthesis(co2, h2o, light):',
          '    return glucose, oxygen',
          '```',
        ].join('\n'),
        position: { x: 120, y: 100 },
      },
    },
  ],

  image: [
    { action: 'clearBoard', payload: {} },
    {
      action: 'requestImage',
      payload: { id: 'img1', prompt: 'Diagram of a plant cell', position: { x: 80, y: 80 } },
    },
  ],

  imageResolve: [
    {
      action: 'resolveImage',
      payload: {
        id: 'img1',
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Labeled_plant_cell_diagram.svg/800px-Labeled_plant_cell_diagram.svg.png',
      },
    },
  ],

  highlight: [
    { action: 'highlightNode', payload: { id: 'mm1' } },
  ],

  clear: [
    { action: 'clearBoard', payload: {} },
  ],
}

// ─── HTTP control panel ───────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Curio Mock Server</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:32px}
    h1{font-size:22px;font-weight:700;color:#f8fafc;margin-bottom:6px}
    p{font-size:13px;color:#64748b;margin-bottom:28px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;max-width:800px}
    button{
      padding:12px 16px;border:none;border-radius:10px;cursor:pointer;
      font-size:13px;font-weight:600;font-family:inherit;
      transition:opacity .15s,transform .1s;
      text-align:left;line-height:1.4;
    }
    button:hover{opacity:.88;transform:translateY(-1px)}
    button:active{transform:translateY(0)}
    .btn-mindmap{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff}
    .btn-flow{background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#fff}
    .btn-explain{background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff}
    .btn-image{background:linear-gradient(135deg,#475569,#94a3b8);color:#fff}
    .btn-clear{background:#1e293b;color:#94a3b8;border:1px solid #334155}
    .btn-custom{background:#1e293b;color:#e2e8f0;border:1px solid #334155}
    .log{
      margin-top:28px;max-width:800px;
      background:#1e293b;border-radius:10px;
      padding:14px 16px;font-size:12px;color:#64748b;
      font-family:monospace;height:180px;overflow-y:auto;
      border:1px solid #334155;
    }
    .log span{display:block;margin-bottom:4px;color:#94a3b8}
    textarea{
      width:100%;background:#1e293b;border:1px solid #334155;border-radius:8px;
      color:#e2e8f0;font-family:monospace;font-size:12px;padding:10px;
      resize:vertical;min-height:90px;margin-top:8px;outline:none;
    }
    label{font-size:12px;color:#64748b;display:block;margin-top:20px;margin-bottom:4px;max-width:800px}
  </style>
</head>
<body>
  <h1>Curio Whiteboard — Mock Server</h1>
  <p>Clients connected: <span id="clients">0</span> &nbsp;|&nbsp; ws://localhost:${WS_PORT}</p>

  <div class="grid">
    <button class="btn-mindmap" onclick="fire('mindmap')">🧠 Mind Map<br/><small style="font-weight:400;opacity:.8">Photosynthesis radial layout</small></button>
    <button class="btn-flow" onclick="fire('flowchart')">🔷 Flowchart<br/><small style="font-weight:400;opacity:.8">Voice app pipeline (ELK layout)</small></button>
    <button class="btn-explain" onclick="fire('explanation')">📝 Explanation Card<br/><small style="font-weight:400;opacity:.8">Typewriter reveal + append</small></button>
    <button class="btn-explain" onclick="fire('markdown')">📄 Markdown Doc<br/><small style="font-weight:400;opacity:.8">Notion-style editor — double-tap to edit, / for commands</small></button>
    <button class="btn-image" onclick="fire('image')">🖼 Request Image<br/><small style="font-weight:400;opacity:.8">Shows loading shimmer</small></button>
    <button class="btn-image" onclick="fire('imageResolve')">✅ Resolve Image<br/><small style="font-weight:400;opacity:.8">Cross-fade placeholder → real</small></button>
    <button class="btn-mindmap" onclick="fire('highlight')">✨ Highlight Node<br/><small style="font-weight:400;opacity:.8">Pulse mm1 + pan camera</small></button>
    <button class="btn-clear" onclick="fire('clear')">🗑 Clear Board</button>
  </div>

  <label>Custom command (JSON):</label>
  <textarea id="custom" placeholder='{ "action": "addNote", "payload": { "text": "Hello world!", "color": "blue" } }'></textarea>
  <div class="grid" style="margin-top:8px">
    <button class="btn-custom" onclick="fireCustom()">Send Custom Command</button>
  </div>

  <div class="log" id="log"><span>Waiting for commands…</span></div>

  <script>
    function log(msg){ const el=document.getElementById('log'); const s=document.createElement('span'); s.textContent=new Date().toLocaleTimeString()+' '+msg; el.appendChild(s); el.scrollTop=el.scrollHeight; }
    async function fire(seq){
      const r=await fetch('/fire/'+seq,{method:'POST'});
      const t=await r.text(); log(t);
    }
    async function fireCustom(){
      const raw=document.getElementById('custom').value.trim();
      if(!raw){log('ERROR: empty command');return;}
      try{ JSON.parse(raw); }catch(e){log('ERROR: invalid JSON');return;}
      const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:raw});
      const t=await r.text(); log(t);
    }
    async function updateClients(){
      const r=await fetch('/clients'); const t=await r.text();
      document.getElementById('clients').textContent=t;
    }
    setInterval(updateClients,2000); updateClients();
  </script>
</body>
</html>`

const sequences = SEQUENCES

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`)

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }

  if (req.method === 'GET' && url.pathname === '/clients') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(String(clients.size))
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/fire/')) {
    const key = url.pathname.slice(6)
    const cmds = sequences[key]
    if (!cmds) {
      res.writeHead(404); res.end('Unknown sequence: ' + key); return
    }
    // Fire each command with a small gap so the queue can breathe
    ;(async () => {
      for (const cmd of cmds) {
        broadcast(cmd)
        await new Promise(r => setTimeout(r, 200))
      }
    })()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`Fired sequence "${key}" (${cmds.length} commands)`)
    return
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const cmd = JSON.parse(body)
        broadcast(cmd)
        res.writeHead(200); res.end('Sent: ' + JSON.stringify(cmd))
      } catch (e) {
        res.writeHead(400); res.end('Bad JSON')
      }
    })
    return
  }

  res.writeHead(404); res.end('Not found')
})

server.listen(HTTP_PORT, () => {
  console.log(`\n  Curio Mock Server`)
  console.log(`  ─────────────────────────────────`)
  console.log(`  WS  →  ws://localhost:${WS_PORT}`)
  console.log(`  UI  →  http://localhost:${HTTP_PORT}`)
  console.log(`  ─────────────────────────────────\n`)
})
