// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,

  // ---- Maximum telemetry ----------------------------------------------------
  // Capture everything regardless of environment. (Profiling is not available
  // in the edge runtime, so it is omitted here.)

  integrations: [
    // Forward console.* calls into Sentry structured logs.
    Sentry.consoleLoggingIntegration({
      levels: ["log", "info", "warn", "error", "debug"],
    }),
  ],

  // Trace 100% of edge transactions.
  tracesSampleRate: 1.0,

  // Ship structured logs to Sentry.
  enableLogs: true,

  // Capture IP, headers, cookies, and request bodies for richer context.
  sendDefaultPii: true,
  beforeSend(event) {
    if (event.request?.url) {
      event.request.url = event.request.url.replace(/([?&]session=)[^&]+/g, "$1[Filtered]");
    }
    return event;
  },
});
