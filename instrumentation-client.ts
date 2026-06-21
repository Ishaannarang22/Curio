// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // ---- Maximum telemetry ----------------------------------------------------
  // Capture everything regardless of environment. Dial the sample rates down if
  // Sentry quota becomes a concern; this config favors completeness over cost.

  integrations: [
    // Distributed tracing across browser → API.
    Sentry.browserTracingIntegration(),
    // Browser JS profiling (requires the `Document-Policy: js-profiling` header,
    // set in next.config.ts).
    Sentry.browserProfilingIntegration(),
    // Session Replay — record the full DOM. We unmask text/media so the tldraw
    // board and copy are visible, but keep credential inputs masked (see below).
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
      maskAllInputs: false,
      // Security carve-out: never record typed credentials in replays.
      mask: ['input[type="password"]', "[data-sentry-mask]"],
      // Capture request/response headers + bodies in the replay timeline.
      networkDetailAllowUrls: [
        typeof window !== "undefined" ? window.location.origin : "",
      ],
      networkCaptureBodies: true,
    }),
    // Record the tldraw <canvas> inside session replays.
    Sentry.replayCanvasIntegration(),
    // Forward console.* calls into Sentry structured logs.
    Sentry.consoleLoggingIntegration({
      levels: ["log", "info", "warn", "error", "debug"],
    }),
  ],

  // Trace 100% of transactions.
  tracesSampleRate: 1.0,
  // Profile 100% of sampled transactions.
  profilesSampleRate: 1.0,

  // Ship structured logs to Sentry.
  enableLogs: true,

  // Record every session, and every session that hits an error.
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,

  // Propagate trace headers to our own origin so spans link browser → server.
  tracePropagationTargets: [
    /^\//,
    typeof window !== "undefined" ? window.location.origin : "",
  ],

  // Capture IP, headers, cookies, and request bodies for richer context.
  sendDefaultPii: true,
  beforeSend(event) {
    if (event.request?.url) {
      event.request.url = event.request.url.replace(/([?&]session=)[^&]+/g, "$1[Filtered]");
    }
    return event;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
