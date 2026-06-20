// Sentry init for the Edge runtime (middleware, edge routes).
// Loaded by instrumentation.ts when NEXT_RUNTIME === "edge".
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: 1.0,
  enableLogs: true,
  debug: false,
});
