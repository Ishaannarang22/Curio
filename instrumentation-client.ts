// Sentry init for the browser. Next.js loads this automatically on the client.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Performance tracing.
  tracesSampleRate: 1.0,

  // Session Replay: record 10% of sessions, and 100% of sessions with an error.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],

  enableLogs: true,
  debug: false,

  // Send user PII (IP, request/user context) for richer observability.
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
});

// Required for navigation/route-change instrumentation in the App Router.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
