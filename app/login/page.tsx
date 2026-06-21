import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/AuthForm";
import "../auth/auth.css";

export const metadata: Metadata = {
  title: "Log in · Curio",
  description: "Sign in to Curio with a magic link.",
};

// `AuthForm` reads `useSearchParams` (for ?next= / ?error=), which must sit
// under a Suspense boundary in the App Router.
export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth-page" />}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
