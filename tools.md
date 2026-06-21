# tools.md — Whiteboard tool contract for the board harness

> The single tool surface the harness LLM calls to drive the tldraw whiteboard,
> backed by the Redis board-state layer in `server/`. This file is the **complete
> contract**: calling convention, every tool schema, and the execution flow.
> It absorbs the earlier `board-tools.md` extensions (sticky notes, explanation
> cards, markdown append, per-node x/y graph primitives).
>
> **Status:** proposed + accepted in brainstorming. Tools map onto the
> `commandQueue.ts` board actions and the `applyCommand` switch in
> `server/src/board-state.ts`. Tools/kinds marked *(new)* require the server work
> listed at the bottom; everything else maps onto code that exists today.
>
> **Still open** (pulling from another branch): which brain owns the tools
> (dedicated board agent vs `board_writer.py` vs `bot.py`) and the tool-calling
> mechanism (native OpenAI `tools` vs pipecat). Schemas here are neutral to both.

---

## Transport (current, post-Redis)

```
harness ──POST :8091/command/:sessionId {action,payload}──▶ applyCommand
                                                              │
                              persist to Redis  board:<sessionId>  (HASH)
                              publish to        board:updates:<sessionId>
                                                              │
   relay (ws://:8090/<sessionId>) ──{action,payload}──▶ commandQueue.ts ──▶ boardApi.ts
```

- **Session-scoped.** Every call carries a `sessionId` (the path param). Redis keys
  are `board:<sessionId>` (nodes), `board:edges:<sessionId>` (edges).
- **Hydration on connect:** a fresh client replays the settled board, so refreshes
  reload instead of going blank.
- The old `:8081/send` / `ws://:8080` bridge is **superseded** by the above.

---

## Calling convention

1. **Native function calling**, `tool_choice: "auto"`, **parallel tool calls
   enabled** — one turn may emit several ops (e.g. `write_notes` + `highlight`).
   The harness executes returned calls in emitted order via the bridge above.

2. **Upsert-by-id is the core mechanic.** Every create tool takes a *semantic* `id`
   the model chooses (e.g. `topic_photosynthesis`). Re-calling with the same `id`
   updates that block **in place** (maps to `boardApi`'s update-by-id path and the
   Redis upsert). Delivers topic continuation, morph-in-place, idempotent retries.
   `id` is the join key across all layers: model semantic id = `commandQueue` idMap
   key = Redis hash field.

3. **Placement is split by altitude:**
   - **High-level artifact tools** (`write_notes`, `make_flowchart`,
     `make_mindmap`, `add_image`, `add_sticky`, `write_explanation`) — the model
     does **not** send pixels. The harness picks open space from the Redis geometry
     model; the model may pass an optional `anchor:{ near, dir }` hint.
   - **Low-level node tools** (`add_node`, `move_block`) — the model **may** send
     explicit `x`/`y` (absolute tldraw page coords) for precise layouts. This is the
     coordinate-freedom path: the agent reads existing `bbox`es from injected state
     and places nodes itself. `x`/`y` optional; omitted ⇒ harness places.

4. **Board state is injected, not queried.** Each turn the harness injects the
   current board from `GET /board/:sessionId` *(new)* as compact JSON:
   `[{ id, type, title, summary, bbox:{x,y,w,h} }]`. The model picks an `id` to
   update or mints a new one. No per-read tool/round-trip.

5. **Geometry is true, not guessed.** Redis stores `w`/`h` per block, and the
   whiteboard **writes settled positions back** after ELK/d3-force layout *(new)*,
   so `bbox` reflects what actually rendered — overlap-avoidance works for both the
   auto-laid and the hand-placed paths.

6. **Distinct, well-named tools** (not one generic `upsert(type, …)`). Tailored
   schemas → the model calls the right tool far more reliably.

7. **Optional `w`/`h`, sensible defaults** everywhere: `flow` 180×60 (80 w/
   subtitle), `mindMap` 140×44 (center 160×52), notes 420 wide, explanation
   300×180, image 300×220.

---

## Tool surface

| Tool | Params | Bridge action | |
|---|---|---|---|
| `write_notes` | `id, title, markdown, anchor?` | `addMarkdown` — prose / bullets / **tables** | base |
| `append_notes` | `id, markdown` | `appendMarkdown` | *(new)* |
| `write_explanation` | `id, text, anchor?, w?, h?` | `addExplanation` — typewriter card | *(new)* |
| `append_explanation` | `id, moreText` | `appendToExplanation` | *(new)* |
| `add_sticky` | `id, text, color?, anchor?` | `addNote` — sticky note | *(new)* |
| `make_flowchart` | `id, title, steps[], anchor?` | `addFlowchart` (client ELK layout) | base |
| `make_mindmap` | `id, center, branches[], anchor?` | `addMindMap` (client d3-force) | base |
| `add_node` | `id, label, kind, x?, y?, parentId?, subtitle?, w?, h?` | `addMindMapNode` / `addFlowNode` | *(new)* |
| `connect_nodes` | `fromId, toId, label?` | `connectNodes` | *(new)* |
| `update_node` | `id, newLabel` | `updateNode` | base |
| `move_block` | `id, x, y` | `moveShape` | *(new)* |
| `add_image` | `id, prompt, caption?, anchor?` | `requestImage` → `resolveImage` (gen **stubbed** v1) | base |
| `highlight` | `id` | `highlightNode` | base |
| `remove_block` | `id` | `removeNode` | base |
| `clear_board` | `—` | `clearBoard` | base |

### Two graph paths (both first-class)
- `make_flowchart` / `make_mindmap` — **fast path**: emit a whole structure, the
  client auto-lays it out; settled positions write back to Redis.
- `add_node` + `connect_nodes` — **precise path**: build node-by-node at chosen
  `x`/`y`. `add_node` with `kind:"mindMap"` and no `parentId` is the **home/center**;
  later `add_node`s with `parentId` auto-draw an edge. Both paths share one idMap,
  so a node from either is addressable by `connect_nodes` / `move_block` / etc.

### Confirmed v1 defaults
- **Tables** ride inside `write_notes` markdown (board renders GFM tables).
- **`add_image`** is a **stub**: records the prompt, shows the shimmer placeholder;
  real generation wired later.
- **"Graphs" = node graphs** (flowchart / mind map). Data charts (bar/line) = a new
  board shape, deferred.

---

## JSON schemas

```json
{
  "type": "function",
  "function": {
    "name": "write_notes",
    "description": "Create or update a Notion-style notes block (prose, bullet/numbered lists, and GFM tables in Markdown). Default text artifact and morph target for live speech. Reuse an existing id to refine in place; mint a new id for a new topic.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "Stable semantic id, e.g. 'topic_photosynthesis'." },
        "title":    { "type": "string", "description": "Short topic title." },
        "markdown": { "type": "string", "description": "Full cleaned Markdown body (headings, **bold**, lists, tables)." },
        "anchor":   { "$ref": "#/$defs/anchor" }
      },
      "required": ["id", "title", "markdown"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "append_notes",
    "description": "Append a section to an existing notes block without resending its whole body. Use to grow a topic's notes as the speaker keeps talking. id must reference a write_notes block.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "Id of an existing write_notes block." },
        "markdown": { "type": "string", "description": "Markdown to append below existing content." }
      },
      "required": ["id", "markdown"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "write_explanation",
    "description": "Create or update an explanation card that reveals its text with a typewriter animation. Good for a focused, spoken-aloud definition or aside. Reuse an existing id to replace its text.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":     { "type": "string", "description": "Stable semantic id, e.g. 'explain_osmosis'." },
        "text":   { "type": "string", "description": "Full text to reveal." },
        "anchor": { "$ref": "#/$defs/anchor" },
        "w":      { "type": "number", "description": "Optional width (default 300)." },
        "h":      { "type": "number", "description": "Optional height (default 180)." }
      },
      "required": ["id", "text"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "append_explanation",
    "description": "Append more text to an existing explanation card; the new text animates in below the current text.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "Id of an existing write_explanation card." },
        "moreText": { "type": "string", "description": "Text to append and animate in." }
      },
      "required": ["id", "moreText"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "add_sticky",
    "description": "Place a short sticky note for a quick callout, reminder, or label.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":     { "type": "string", "description": "Stable semantic id, e.g. 'note_remember_atp'." },
        "text":   { "type": "string", "description": "Short note text." },
        "color":  { "type": "string", "description": "Optional tldraw note color (default 'yellow')." },
        "anchor": { "$ref": "#/$defs/anchor" }
      },
      "required": ["id", "text"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "make_flowchart",
    "description": "Create or update a flowchart of sequential steps (client-side ELK layout). Reuse an existing id to update in place; mint a new id for a new topic.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":    { "type": "string", "description": "Stable semantic id, e.g. 'flow_photosynthesis'." },
        "title": { "type": "string" },
        "steps": {
          "type": "array",
          "description": "Ordered steps; connected sequentially. Step ids are stable across updates.",
          "items": {
            "type": "object",
            "properties": {
              "id":       { "type": "string" },
              "label":    { "type": "string" },
              "subtitle": { "type": "string" }
            },
            "required": ["id", "label"]
          }
        },
        "anchor": { "$ref": "#/$defs/anchor" }
      },
      "required": ["id", "title", "steps"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "make_mindmap",
    "description": "Create or update a radial mind map: one center node and labelled branches (client-side d3-force). Reuse an existing id to add/relabel branches in place.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":     { "type": "string", "description": "Stable semantic id, e.g. 'map_cell_biology'." },
        "center": { "type": "string", "description": "Center node label." },
        "branches": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id":    { "type": "string" },
              "label": { "type": "string" }
            },
            "required": ["id", "label"]
          }
        },
        "anchor": { "$ref": "#/$defs/anchor" }
      },
      "required": ["id", "center", "branches"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "add_node",
    "description": "Create or update a SINGLE graph node and place it precisely. kind 'mindMap' => a mind-map node (omit parentId for the center/home node; set parentId to auto-draw an edge from the parent). kind 'flow' => a flowchart box. Pass x/y (absolute page coords) for exact placement, or omit to let the harness place it. Reuse an id to relabel/resize in place.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "Stable semantic id, e.g. 'map_home' or 'flow_step1'." },
        "label":    { "type": "string", "description": "Node label." },
        "kind":     { "type": "string", "enum": ["mindMap", "flow"], "description": "Which node shape to create." },
        "x":        { "type": "number", "description": "Optional absolute page x (top-left). Omit to auto-place." },
        "y":        { "type": "number", "description": "Optional absolute page y (top-left). Omit to auto-place." },
        "parentId": { "type": "string", "description": "Optional; if set, draws an edge from this parent to the new node (mind-map use)." },
        "subtitle": { "type": "string", "description": "Optional secondary line (flow nodes)." },
        "w":        { "type": "number", "description": "Optional width (defaults: mindMap 140, flow 180)." },
        "h":        { "type": "number", "description": "Optional height (defaults: mindMap 44, flow 60/80)." }
      },
      "required": ["id", "label", "kind"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "connect_nodes",
    "description": "Draw a bound arrow between two existing nodes (from add_node, make_flowchart, or make_mindmap). The arrow re-binds as nodes move.",
    "parameters": {
      "type": "object",
      "properties": {
        "fromId": { "type": "string", "description": "Source node id." },
        "toId":   { "type": "string", "description": "Target node id." },
        "label":  { "type": "string", "description": "Optional edge label." }
      },
      "required": ["fromId", "toId"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "update_node",
    "description": "Relabel an existing node in place by id.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "Id of an existing node." },
        "newLabel": { "type": "string", "description": "New label text." }
      },
      "required": ["id", "newLabel"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "move_block",
    "description": "Reposition any existing block (node, notes, image, sticky, explanation) to absolute page coordinates, animated. Use to re-arrange the board or open space for a new block.",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "Id of an existing block." },
        "x":  { "type": "number", "description": "Absolute page x (top-left)." },
        "y":  { "type": "number", "description": "Absolute page y (top-left)." }
      },
      "required": ["id", "x", "y"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "add_image",
    "description": "Place an illustrative image block for a concept. v1 records the prompt and shows a placeholder; generation is wired later. Reuse an existing id to replace the image.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":      { "type": "string", "description": "Stable semantic id, e.g. 'img_chloroplast'." },
        "prompt":  { "type": "string", "description": "What the image should depict." },
        "caption": { "type": "string" },
        "anchor":  { "$ref": "#/$defs/anchor" }
      },
      "required": ["id", "prompt"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "highlight",
    "description": "Pulse an existing block to draw attention to it (e.g. while the voice agent references it). Pans the camera to it if off-screen.",
    "parameters": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "Id of an existing block." }
      },
      "required": ["id"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "remove_block",
    "description": "Delete a block from the board by id.",
    "parameters": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"]
    }
  }
}
```

```json
{
  "type": "function",
  "function": {
    "name": "clear_board",
    "description": "Remove everything from the board. Use sparingly, e.g. on an explicit 'start over'.",
    "parameters": { "type": "object", "properties": {} }
  }
}
```

### Shared `anchor` definition

```json
{
  "$defs": {
    "anchor": {
      "type": "object",
      "description": "Optional relational placement hint. Omit to let the harness pick open space.",
      "properties": {
        "near": { "type": "string", "description": "Id of an existing block to place near." },
        "dir":  { "type": "string", "enum": ["below", "right", "left", "above"] }
      }
    }
  }
}
```

---

## Execution contract (tool_call → board)

For each returned `tool_call` the harness:

1. **Resolves placement** — for `add_node`/`move_block` with explicit `x`/`y`, use
   them. Otherwise, if no stored position exists for this `id`, compute an open
   `{x, y}` from the Redis geometry (honoring `anchor` if given); for an update,
   reuse the stored position.
2. **POSTs** `{ action, payload }` to `:8091/command/:sessionId`, translating
   intent-level params into the board action's payload (e.g. `write_notes` →
   `{action:"addMarkdown", payload:{id, markdown}}`; `add_node` kind `flow` →
   `{action:"addFlowNode", payload:{id, label, subtitle, position:{x,y}}}`).
3. **`applyCommand` persists + publishes** — upserts the `NodeRecord` (with
   `w`/`h`) into `board:<sessionId>` and publishes the live command to
   `board:updates:<sessionId>`; the relay fans it out to clients.
4. **Client writes settled geometry back** — after ELK/d3-force layout the
   whiteboard POSTs real `{x,y,w,h}` back so the next turn's injected `bbox` is
   accurate.

---

## Server work to build this (`server/` + `boardApi.ts`)

Modeled in Redis today: `mindMap`, `flow`, `image`. **New** work:

- **New `NodeKind`s** `markdown | note | explanation` in `types.ts` + `applyCommand`
  cases in `board-state.ts` so these artifacts persist, hydrate, and appear in
  board state (chosen: model them in Redis, not live-only).
- **`w`/`h` on `NodeRecord`** + carry through `nodeToCommands` / `applyCommand`.
- **Settled-position writeback channel** — a client→server route (e.g.
  `POST :8091/geometry/:sessionId {id,x,y,w,h}`) the whiteboard calls after layout;
  `patchNode` updates the stored bbox.
- **`GET /board/:sessionId`** — compact `[{id,type,title,summary,bbox}]` agent-read
  endpoint (distinct from `/state`, which stays for client hydration).
- **`boardApi.ts`**: new `appendMarkdown` (read→concat→update), `moveShape(id,x,y)`
  via `animateShape`, `w`/`h` passthrough on `addFlowNode`/`addMindMapNode`, and an
  `id`+idMap entry for `addNote` so stickies are addressable.

## Not in v1 (tracked for later)
- Real image generation behind `add_image`.
- Data charts (bar/line) as a new board shape.
- Research/retrieval as an output type.
- Brain owner + tool-calling mechanism — pending the harness branch.
