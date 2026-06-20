@AGENTS.md

# Sentry (error monitoring + tracing)

This project uses the **`@sentry/nextjs`** SDK (v10) for error monitoring,
performance tracing, session replay, and logs. Notes below are from the
[official Next.js guide](https://docs.sentry.io/platforms/javascript/guides/nextjs/).

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
