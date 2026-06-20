// Sentry init for the Node.js server runtime.
// Loaded by instrumentation.ts when NEXT_RUNTIME === "nodejs".
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Capture 100% of traces in dev; lower this in production (e.g. 0.1).
  tracesSampleRate: 1.0,

  // Send structured logs to Sentry.
  enableLogs: true,

  // Prints useful info to the console while setting up. Turn off in prod.
  debug: false,
});
