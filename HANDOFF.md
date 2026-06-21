# Handoff — Build plans for the board tools (agents-as-tools)

> Transient working doc for a fresh agent. The architecture for how the voice
> agent drives the whiteboard is **settled** and written up in
> [agent-tool-architecture.md](./agent-tool-architecture.md). **Read that file
> first — it is the spec.** This session's job: turn that architecture into
> concrete build plans for the tools, then start building. Nothing is built yet.

## What was decided last session (all in agent-tool-architecture.md)

The board interaction is becoming **agents-as-tools**: the voice agent is an
**orchestrator**; the Structuring + Spawner agents sit **behind tool calls** —
they look like ordinary tools to the voice LLM but are full agents underneath.

Settled:
1. **Voice orchestrator owns the tools** (not a separate board agent, not an
   independent transcript observer like today's `BoardWriter`).
2. **Dispatch-and-forget** — orchestrator fires a worker tool, gets a cheap ack,
   keeps talking; workers write to the board on their own timeline. Keeps voice
   fast.
3. **Pedagogical judgment** ("is there a question / did they get it wrong") lives
   in the orchestrator (voice channel), not a separate agent.
4. **Topic boundary** is found by a **dedicated cheap detector** that *wakes* the
   orchestrator — it only fires at boundaries, not per utterance.
5. **Two tool surfaces:** outer = coarse agent-tools the orchestrator sees
   (`structure_topic`, `spawn_artifacts`); inner = the 15 `commandQueue.ts`
   actions the workers use to draw.

This **overrides** implementation.md §3.4/#18 (voice LLM is back as the
orchestrator brain) and dissolves the standalone §1.1 Inference Layer (routing →
tool-choice; judgment → orchestrator; trigger → the boundary detector).

## NEXT SESSION — create the build plans

Goal: go from architecture → concrete, buildable tool plans. Suggested order:

1. **Resolve the open questions in agent-tool-architecture.md first** — they gate
   the schemas. Grill them one at a time, each with a recommended answer (the
   user steers hard and wants design forks settled before code):
   - Does the orchestrator get any **direct** board primitives (`highlight_node`,
     and does the **live verbatim feed** survive at all), or is it purely the two
     coarse agent-tools? *(this was the live fork when the session ended)*
   - What does the orchestrator **pass** to a worker tool — inline topic
     transcript vs a topic id?
   - **Where does the sealed raw transcript live** (in-memory / Supabase / inline)?
   - **Tool-calling API shape:** native OpenAI `tools`/`tool_calls` on the
     orchestrator endpoint vs pipecat function-calling. Workers are separate
     Claude agents (Anthropic SDK / small agent loop).
   - **Spatial concurrency** of Structuring (main region) vs Spawner (margin) —
     is the serialized command queue enough?

2. **Then plan the tools concretely:**
   - Outer tool schemas: `structure_topic`, `spawn_artifacts` (+ any direct
     primitives decided above) — names, params, what the ack returns.
   - Inner toolbox: confirm the 15 actions in `commandQueue.ts` as the workers'
     vocabulary (it is the source of truth for each payload).
   - The boundary detector: what model/heuristic, what signal it emits, how it
     wakes the orchestrator.
   - Sentry: one `gen_ai.invoke_agent` span per worker (implementation.md §4.1).

## Code reality to plan against (current, NOT yet tool-driven)

- `agent/bot.py` — speaking LLM (`OpenAILLMService`), **no tools**, talks every
  turn. The orchestrator will be built here.
- `agent/board_writer.py` — the current "caller channel": plain
  `/chat/completions` returning one Markdown string, hardcoded single
  `addMarkdown` POST. **This is the thing being replaced** by the agents-as-tools
  design (it's an independent per-utterance observer; the new caller channel is
  orchestrator-driven at boundaries).
- `whiteboard/src/lib/commandQueue.ts` — the 15 board actions = the inner tool
  surface (source of truth for payloads). Reached via POST `:8081/send` →
  `mock-server.js` WS `:8080` → `commandQueue` → `boardApi.ts`.

## How to run the demo (confirmed working previously)

Four processes:
1. `cd whiteboard && node mock-server.js` — bridge: WS `:8080`, HTTP `:8081`
   (`GET :8081/` is a manual test panel; logs `[SEND]` on each broadcast).
2. `cd whiteboard && npm run dev` — Vite UI, auto-connects to `:8080`.
3. `cd agent && uv run bot.py` ← **must be `uv run`** (uses `.venv` / Python
   3.13), not `python bot.py` (system 3.14 → `ModuleNotFoundError: sentry_sdk`).
   Wait for `🚀 Bot ready!`, open `http://localhost:7860/`, Connect, allow mic.
4. Caller brain needs `AI_GATEWAY_API_KEY` (Haiku) in `agent/.env` or root
   `.env.local`. Without it the old `BoardWriter` self-disables; voice still runs.
   ⚠️ Never read `.env*` except `.env.example*`.

Cheap test: open `:8081/` and click the sample buttons (mindmap/flowchart/
markdown/image/highlight) — exercises the inner tool surface with no agent.

## Working-style notes (the user steers hard)
- **Grill design forks one at a time, each with a recommended answer.** Don't
  write code before forks are settled.
- **Design docs are an iterating snapshot, not law** — decisions (even numbered
  ones) can be overwritten freely as the idea evolves; just update the doc.
- Don't scope-cut for hackathon status (only affects licensing).
- Commits: no `Co-Authored-By` trailer.

## Git
- Branch `main`. Uncommitted this session: `HANDOFF.md` (this file, rewritten)
  and new `agent-tool-architecture.md`. Nothing committed yet.
- Remote `origin` → `github.com/Ishaannarang22/Curio.git`; local git user
  `Devaj6190`.
