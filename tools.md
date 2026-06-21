# tools.md — Whiteboard tool contract for the board harness

> The tool surface the harness LLM (Claude Sonnet, GLM-5 backup) calls to drive
> the tldraw whiteboard. This is the **tool contract** only — the surrounding
> architecture (who calls these, one brain vs orchestrator+workers, the
> topic-boundary detector) is still being settled; see
> [agent-tool-architecture.md](./agent-tool-architecture.md). These tools are
> intent-level and map 1:1-ish onto the existing `commandQueue.ts` board actions,
> so they work under either architecture.
>
> **Status:** proposed + accepted in brainstorming. Not built. Schemas below are
> the implementation target.

---

## Calling convention

1. **Native OpenAI `tools` (function calling).** `tool_choice: "auto"`,
   **parallel tool calls enabled** — one turn may emit several ops (e.g.
   `write_notes` + `highlight`). The harness executes the returned `tool_calls`
   in emitted order through the existing bridge, then updates Redis.

2. **Upsert-by-id is the core mechanic.** Every create tool takes a *semantic*
   `id` the model chooses (e.g. `topic_photosynthesis`). Calling a tool again
   with the same `id` updates that block **in place** (maps to
   `boardApi`'s update-by-id path). This single rule delivers:
   - **topic continuation** — same id ⇒ keep building the same block,
   - **morph-in-place** — replace a block's content as a turn is refined,
   - **idempotent retries** — re-issuing a call is safe.

3. **The model never sends pixel coordinates.** Placement is the harness's job
   (find open space from the Redis geometry model). The most the model sends is
   an optional relational hint: `anchor: { near: "<id>", dir: "below|right|left|above" }`.

4. **Board state is injected, not queried.** Each turn the harness injects the
   current board (from Redis) into the prompt as compact JSON:
   `[{ id, type, title, summary, bbox:{x,y,w,h} }]`. Reads need no tool/round-trip;
   the model just picks an `id` to update or mints a new one.

5. **Distinct, well-named tools** (not one generic `upsert(type, …)`). Models call
   the right tool far more reliably when each has a tailored schema, and it
   matches the existing board API altitude.

---

## Tool surface (v1)

| Tool | Params | Bridge action (`commandQueue.ts`) |
|---|---|---|
| `write_notes` | `id, title, markdown, anchor?` | `addMarkdown` — prose / bullets / **tables** (default text artifact + morph target) |
| `make_flowchart` | `id, title, steps[], anchor?` | `addFlowchart` (client-side ELK layout) |
| `make_mindmap` | `id, center, branches[], anchor?` | `addMindMap` (client-side d3-force) |
| `add_image` | `id, prompt, caption?, anchor?` | `requestImage` → `resolveImage` (generation **stubbed** in v1) |
| `highlight` | `id` | `highlightNode` — pulse a block while referencing it |
| `remove_block` | `id` | `removeNode` |
| `clear_board` | — | `clearBoard` |

### Confirmed v1 defaults
- **Tables** ride inside `write_notes` markdown (the board renders GFM tables) —
  no separate table tool.
- **`add_image`** ships as a **stub**: it records the prompt and shows the
  shimmer placeholder shape; real image generation is wired later.
- **"Graphs" = node graphs** (covered by `make_flowchart` / `make_mindmap`).
  **Data charts** (bar/line/scatter) would be a *new* board shape — deferred.

---

## JSON schemas

```json
{
  "type": "function",
  "function": {
    "name": "write_notes",
    "description": "Create or update a Notion-style notes block (prose, bullet/numbered lists, and GFM tables in Markdown). This is the default text artifact and the morph target for live-streamed speech. Reuse an existing id to refine the block in place; mint a new id for a new topic.",
    "parameters": {
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "Stable semantic id, e.g. 'topic_photosynthesis'." },
        "title":    { "type": "string", "description": "Short topic title." },
        "markdown": { "type": "string", "description": "Full cleaned Markdown body for the block (headings, **bold**, lists, tables)." },
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
    "name": "make_flowchart",
    "description": "Create or update a flowchart of sequential steps. Reuse an existing id to update it in place; mint a new id for a new topic.",
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
    "description": "Create or update a radial mind map: one center node and labelled branches. Reuse an existing id to add/relabel branches in place.",
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
      "properties": {
        "id": { "type": "string" }
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

1. **Resolves placement** — if no real position exists in Redis for this `id`,
   compute an open `{x, y}` (honoring `anchor` if given); for an update, reuse
   the stored position.
2. **POSTs** `{ action, payload }` to the bridge (`:8081/send` →
   `ws://:8080` → `commandQueue.ts`), translating the intent-level params into the
   board action's payload (e.g. `write_notes` → `{action:"addMarkdown",
   payload:{id, markdown}}`).
3. **Writes Redis** — upsert `{ id, type, title, content, bbox, updatedAt }` so the
   next turn's injected state is current. The whiteboard syncs **real**
   post-layout positions back to Redis (two-way), so flowchart/mind-map geometry
   reflects what was actually rendered.

`id` is the join key across all three: the model's semantic id, the
`commandQueue` idMap key, and the Redis key are the same string.

---

## Not in v1 (tracked for later)
- Real image generation behind `add_image`.
- Data charts (bar/line) as a new board shape.
- Research/retrieval as an output type (separate sub-system).
- Incremental graph editing tools (`add_node` / `connect`) — folded into
  `make_flowchart` / `make_mindmap` upserts for now.
