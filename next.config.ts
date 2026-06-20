import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
};

export default withSentryConfig(nextConfig, {
  // Org and project from your Sentry account. Used for source map uploads.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Auth token for uploading source maps during `next build`.
  // Set SENTRY_AUTH_TOKEN in CI / .env.local (never commit it).
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Only print SDK build logs when explicitly debugging.
  silent: !process.env.CI,

  // Route Sentry requests through your own domain to dodge ad-blockers.
  tunnelRoute: "/monitoring",
});
