// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,

  // ---- Maximum telemetry ----------------------------------------------------
  // Capture everything regardless of environment. Dial the sample rates down if
  // Sentry quota becomes a concern; this config favors completeness over cost.

  integrations: [
    // CPU profiling of sampled server transactions.
    nodeProfilingIntegration(),
    // Forward console.* calls into Sentry structured logs.
    Sentry.consoleLoggingIntegration({
      levels: ["log", "info", "warn", "error", "debug"],
    }),
  ],

  // Trace 100% of server transactions.
  tracesSampleRate: 1.0,
  // Profile 100% of sampled transactions.
  profilesSampleRate: 1.0,

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
