# prd.md — Product requirements

> The "what" of Curio: the interaction model, data model, and behavioral rules.
> See [idea.md](./idea.md) for the vision and [implementation.md](./implementation.md)
> for the architecture that realizes these requirements. Living document.

---

## 1. The capture → structure loop (the heart of the system)

### 1.1 Live transcription

As the student speaks, **verbatim text is written to the board live** as nodes. This
path is NOT gated by any agent — transcription is immediate so the student sees their
words land. Agents work in parallel, after the fact.

### 1.2 Topic boundaries are semantic and hierarchical

The trigger for structuring is **content-driven, read off the whiteboard itself** —
NOT silence, NOT a voice command, NOT a timer.

The system maintains an **implicit topic tree**:

- Example: the student covers *sorting algorithms* → *bubble sort*, then *merge sort*,
  etc. When **bubble sort** is complete, that leaf can be repurposed (structured).
  When **all** the sorting algorithms are done, the **parent** ("sorting algorithms")
  can be repurposed too.
- This is **recursive**: small complete units get structured, then their parents get
  structured, bottom-up.
- There is a **granularity floor**: do NOT recurse down to the tiniest fragments. Only
  structure things that constitute a *proper topic*. (Exact heuristic for "proper
  topic" is TBD — see Open Questions.)

### 1.3 Completeness = retroactive seal + re-openable

Because there's no time/voice cue, "is this topic done?" is answered **retroactively**:

- A topic is **sealed** when the student clearly moves on to a sibling / new topic.
  Structuring fires on the just-finished topic at that point.
- If the student **returns** to a sealed topic, structuring **re-opens and re-runs**.
  All structuring is therefore reversible and append-able (idempotent over raw input).

**Detection (locked).** A cheap **per-turn classifier** runs in the Python voice
backend on every Flux `EndOfTurn` utterance. Given the topic **tree skeleton**
(node ids + labels, marking active/sibling/sealed), the **full raw of the active
node**, and the new utterance, it emits a tree-move verdict:
`CONTINUE | DESCEND(label) | SIBLING(label) | ASCEND | RETURN(id)`. Sealing is
**semantic only — no timers, no voice gaps**. The triggering utterance is
attributed to the **destination** node (the sealed node keeps only its own raw).
The **trailing topic** (last one talked about) is sealed on **session
end / disconnect** — the only non-content trigger.

**Fire timing.** A **leaf seal** structures that leaf's raw immediately
(provisional artifact, live feedback). A **parent seal** (student leaves the
whole subtree) re-runs structuring over the **whole subtree's raw**; the LLM
decides granularity (keep N child artifacts vs merge into one), overriding the
provisional views. (Replaces the `board_writer.py` prototype's 8s idle-timer +
`topicId`-minting model.)

### 1.4 Source of truth — raw retained, structure derived (event-sourcing-style)

- The **raw transcript per topic is the permanent source of truth.** After structuring,
  the raw is hidden/collapsed but never destroyed.
- **Structured views** (flowchart / mind map / diagram / cleaned text) are
  **regenerable projections** of the raw. They can be re-rendered, re-formed, or
  thrown away and rebuilt at any time.

### 1.5 Editing is raw-only

The student can **never directly edit a structured artifact.** To change a completed
topic:

1. **Revert** the structured view back to its raw transcript.
2. **Edit / append** the raw.
3. **Re-generate** the structured view.

This keeps the data model honest: agents only ever read raw and emit projections.

---

## 2. Structured output requirements

The Structuring Agent (see [implementation.md](./implementation.md) §"Structuring
Agent") runs **two stages** per seal — first *does this even need restructuring?*, then
*which form?* — and **chooses the form from the content's shape** (default, no friction):

- sequential / process → **flowchart**
- one central concept radiating out → **mind map**
- relationships between things (a graph) → **diagram**
- **none of the above → leave the raw text as-is** (no forced shape; "cleaned, structured
  text" is not a separate render — short/narrative/single-idea topics simply stay raw).

The three shapes are real one-shot board tools (`make_flowchart` / `make_mindmap` /
`make_diagram`). The **student can override by voice** ("make that a mind map instead").
Since the view is a regenerable projection, swapping form is just a re-render.

## 3. Study artifact requirements

The Spawner Agent generates **side study artifacts**: sticky notes, definitions,
flashcards.

- Artifacts are **functional but board-only**: interactive on the canvas (flip a
  flashcard, hover for a definition).
- **No separate study/quiz mode and no spaced-repetition system** — everything lives on
  the board.

---

## 4. Non-goals (current)

- **No lecture/"class" mode in v1** (future).
- **No separate study mode / spaced-repetition** — study artifacts are board-only.
- **No real-time interruptions** — the bot does not cut in mid-thought.
- **No uploaded-material grounding in v1** — model knowledge only.
- **No direct editing of structured artifacts** — editing is always raw-then-regenerate.

---

## 5. Open product questions

- **"Proper topic" granularity floor** — concrete heuristic for what's big enough to
  structure vs. too small to bother.
- **Persistence / sessions / accounts** — are boards saved, revisited, multi-session?
- **Export / sharing** — can notes leave the app?
- **Wrong-path handling** — we dropped interruptions; if the inference layer detects a
  wrong path, how (if at all) is it surfaced later?
- **Platform** — web / desktop / mobile first? (See also [implementation.md](./implementation.md).)

---

## 6. Decision log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Solo think-out-loud mode first; class mode later | Matches "explain your ideas" + AI companion; lecture capture is a different product. |
| 2 | Gaps stay as gaps; bot doesn't supply its own knowledge as the student's | Protects Feynman integrity; surfaces what the student doesn't know. |
| 3 | Board may move/animate while talking | Voice is the primary loop; board is reference, not the focus. |
| 4 | Talk-back on pauses; no real-time interruptions | Avoids derailing the monologue. |
| 5 | Inference layer fires at topic boundary, is a dispatcher not an agent | Keeps the hot path cheap; classification ≠ acting. |
| 6 | Grounding = model knowledge only | Simplest; no upload friction. Accepts some judgment risk. |
| 7 | Topic boundaries are semantic + hierarchical, read off board content | No reliable time/voice cue; supports recursive bottom-up structuring. |
| 8 | Completeness = retroactive seal + re-openable | Avoids premature restructuring; supports revisiting a topic. |
| 9 | Raw transcript is durable source of truth; structured views are derived | Makes re-open/merge/re-form safe (event-sourcing-style). |
| 10 | Editing is raw-only (revert → edit → regenerate) | Consistent with #9; agents only read raw + emit projections. |
| 11 | Fork tldraw for the canvas | Stronger engine; license irrelevant for a hackathon. |
| 12 | Structuring Agent infers form from content; student can override by voice | Least-resistive default with an escape hatch. |
| 13 | Spawned artifacts are functional but board-only | Interactive study bits without building a separate study app. |
| 14 | Concurrency: different spaces + both read immutable raw | Solves spatial collisions AND dangling-reference races. |
| 15 | Voice agent = **our fork** of the pulse (Pipecat 1.3.0) scaffold in `agent/` — reference/starting point we own, not an external integration | Code read; STT=Deepgram Flux, TTS=Cartesia Sonic-3, OpenAI-compatible brain, RTVI caption stream, Supabase persistence. We rewrite it freely. See implementation.md §3. |
| 16 | Persistence = **Supabase** (Postgres + PostgREST), `messages(conversation_id, role, content)`, RLS via end-user JWT | The voice agent already writes turns this way; reuse it as the durable transcript store. |
| 17 | Observability = **Sentry** across web (`@sentry/nextjs`) + agent (`sentry_sdk`), shared DSN; our agents traced as spans with token usage | One project = end-to-end traceable study session. See implementation.md §4. |
| 18 | Talk-back owner = **Curio (our Inference Layer)**, not pulse's per-turn LLM; pulse is reduced to STT/TTS transport | Curio must be mostly silent and speak only at topic boundaries (#4/#5); a per-turn conversational brain fights that. Requires an inbound "speak this" channel + removing pulse's per-turn LLM from the speaking path. See implementation.md §3.4–3.5. |
| 19 | Topic boundary = **per-turn classifier** in the Python voice backend over the Flux EndOfTurn stream; verdict `CONTINUE / DESCEND / SIBLING / ASCEND / RETURN` against a **recursive topic tree** | Cheap hot-path detector, separate from the heavy Structuring Agent. Replaces board_writer.py's idle-timer + topicId model. |
| 20 | Sealing is **semantic only — no timers, no voice gaps**; trailing topic sealed on **session end** | Honors #7 (no reliable time/voice cue); session-end is the one unambiguous non-content trigger for the last topic. |
| 21 | Triggering utterance is attributed to the **destination** node | Keeps each node's raw clean (sealed node not polluted by the sentence that ended it). |
| 22 | **Leaf seal** structures provisionally; **parent seal** re-renders the whole subtree, LLM decides 1-vs-N granularity | Live feedback as the student goes + clean bottom-up rollup; granularity floor (#1.2) delegated to LLM judgment, not a fixed heuristic. |
