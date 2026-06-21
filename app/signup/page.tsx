import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/AuthForm";
import "../auth/auth.css";

export const metadata: Metadata = {
  title: "Sign up · Curio",
  description: "Create your Curio account with a magic link.",
};

// `AuthForm` reads `useSearchParams` (for ?next= / ?error=), which must sit
// under a Suspense boundary in the App Router.
export default function SignupPage() {
  return (
    <Suspense fallback={<main className="auth-page" />}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
