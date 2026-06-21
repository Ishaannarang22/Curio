@AGENTS.md

# Curio — docs index & working agreement

Curio is a **voice-first, AI-companion note-taking app**. A student talks through a
topic out loud (the Feynman technique) and the system builds a living tldraw
whiteboard of structured notes, diagrams, and study artifacts in real time. Voice is
the primary input; the board is the primary output.

## Project docs (read the relevant one before working on a feature)

| Doc | What's in it |
| --- | --- |
| [idea.md](./idea.md) | The **why** — product vision, the Feynman core bet, what the AI companion does, modes, product principles. |
| [prd.md](./prd.md) | The **what** — the capture→structure loop, source-of-truth/data model, editing rules, non-goals, decision log, open product questions. |
| [implementation.md](./implementation.md) | The **how** — agents & pipeline topology, tech stack, voice-agent integration contract, Sentry agent observability. |

These three are living docs split out of the original product brief. When a decision
changes, update the relevant doc (and the decision log in [prd.md](./prd.md)); keep
this `CLAUDE.md` a thin index.

# How the agent talks to the whiteboard (READ before touching the agent or board)

**Intended design: the agent interacts with the whiteboard through LLM tool
calls.** The board exposes a vocabulary of actions; the agent's job is to call
the right one(s) per turn. This is the spec — treat divergence from it as a bug
to fix, not a fact to preserve.

**Current reality (as of the dual-channel commit `c19664f`): NOT yet
tool-driven.** There is zero tool-calling in the codebase today:
- `agent/bot.py` — the speaking LLM has **no tools**; it only talks.
- `agent/board_writer.py` (caller channel) does a **plain chat completion** that
  returns a Markdown string, then hardcodes a single `addMarkdown` POST. One
  move only — it cannot make mind maps, flowcharts, images, etc.

**The transport (don't change this part):** the agent POSTs
`{action, payload}` to `http://localhost:8081/send` → `scripts/whiteboard-mock-server.mjs`
(run via `npm run whiteboard:mock`) broadcasts over `ws://localhost:8080` →
`components/whiteboard/lib/commandQueue.ts` executes via
`components/whiteboard/lib/boardApi.ts`. Converting to tool calls is
**agent-side only**: give an LLM a tool schema for the actions below and route
each `tool_call` to that same POST.

**The tool surface** = the `switch (cmd.action)` cases in `commandQueue.ts`:
`addMarkdown`, `addNote`, `addExplanation`, `appendToExplanation`, `addMindMap`,
`addMindMapNode`, `addFlowchart`, `addFlowNode`, `connectNodes`, `updateNode`,
`removeNode`, `requestImage`, `resolveImage`, `highlightNode`, `clearBoard`.
(See that file for each one's exact payload — it is the source of truth.)

**Before building the tool-calling feature, ASK the user — one question at a
time, each with a recommended answer (this is how they want to work; they steer
hard and dislike code written before the design forks are settled).** Open forks:
which brain owns the tools (caller channel = recommended / speaking agent / a new
dedicated board agent); native OpenAI `tools` vs pipecat function-calling;
whether the board brain reads current board state vs keeps its own memory; one
growing doc vs a new shape per topic. When in doubt about ANY design decision,
surface it rather than silently defaulting.

# Sentry (error monitoring + tracing + agent observability)

This project uses the **`@sentry/nextjs`** SDK (v10) for error monitoring,
performance tracing, session replay, logs, and **agent call/usage observability**.
Notes below are from the
[official Next.js guide](https://docs.sentry.io/platforms/javascript/guides/nextjs/).

> For instrumenting the agent pipeline specifically (per-agent spans + token usage),
> see [implementation.md](./implementation.md) §"Sentry agent observability".

## How the SDK is wired up

Next.js runs in three environments, so Sentry needs three `Sentry.init()` calls:

| File | Runtime | Purpose |
| --- | --- | --- |
| `instrumentation-client.ts` | Browser | Client errors, replay, web vitals. Next.js loads it automatically. Also exports `onRouterTransitionStart` for navigation tracing. |
| `sentry.server.config.ts` | Node.js server | Server-side errors and traces. |
| `sentry.edge.config.ts` | Edge runtime | Middleware / edge route errors. |
| `instrumentation.ts` | Server boot | `register()` lazy-imports the server/edge config based on `NEXT_RUNTIME`; exports `onRequestError = Sentry.captureRequestError`. |
| `app/global-error.tsx` | Browser | Catches root-level React render errors and forwards them via `Sentry.captureException`. |
| `next.config.ts` | Build | Wrapped with `withSentryConfig(...)` for source map upload and the ad-blocker tunnel. |

## Configuration

- **DSN** comes from `process.env.NEXT_PUBLIC_SENTRY_DSN`. It is public/safe to
  expose on the client. Get it from Sentry: *Project Settings → Client Keys (DSN)*.
- `tracesSampleRate`: `1.0` captures every transaction. **Lower to ~`0.1` in
  production** to control quota.
- `replaysSessionSampleRate` (`0.1`) / `replaysOnErrorSampleRate` (`1.0`):
  record 10% of sessions, but 100% of any session that hits an error.
- `enableLogs: true` ships structured logs to Sentry.
- Source maps upload at build time via `withSentryConfig` using `SENTRY_ORG`,
  `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN`. The auth token must **never** be
  committed — keep it in `.env.local` / CI secrets only.
- `tunnelRoute: "/monitoring"` proxies Sentry requests through this app's own
  domain so ad-blockers don't drop them.

## Setup checklist

1. Copy `.env.example` → `.env.local` and set `NEXT_PUBLIC_SENTRY_DSN` (and the
   `SENTRY_*` build vars if you want source maps).
2. `npm run dev`, then trigger an error to confirm events arrive in Sentry.
3. The fully automated alternative is the wizard:
   `npx @sentry/wizard@latest -i nextjs` (requires a Sentry login; it regenerates
   the files above and creates a `/sentry-example-page` test route).

## Common API

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.captureException(error);              // report a caught error
Sentry.captureMessage("something happened"); // report a message
Sentry.setUser({ id, email });               // attach user context
Sentry.setTag("feature", "checkout");        // attach a searchable tag

await Sentry.startSpan({ name: "task" }, async () => { /* traced work */ });
```
