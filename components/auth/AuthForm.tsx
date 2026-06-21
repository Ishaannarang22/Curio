"use client";

/**
 * Magic-link auth form, shared by /login and /signup.
 *
 * Passwordless flow: `supabase.auth.signInWithOtp` with `emailRedirectTo`
 * pointing at our PKCE callback. The callback then runs
 * `exchangeCodeForSession` and redirects to `next` (default /boards).
 *
 * `mode="signup"` additionally captures a display name (stored in user
 * metadata via `options.data.display_name`). Both modes create the user if it
 * doesn't exist (`shouldCreateUser: true`) so a magic link "just works" for
 * first-time and returning users alike.
 *
 * Visual language: the Orb hero + the .auth-* classes in app/auth/auth.css.
 */

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Orb, type OrbState } from "@/components/whiteboard/Orb";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";

interface AuthFormProps {
  mode: Mode;
}

/** Keep `next` same-origin/relative so it can't be hijacked into an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/boards";
  return raw;
}

const COPY: Record<Mode, { title: string; subtitle: string; cta: string }> = {
  login: {
    title: "Welcome back",
    subtitle:
      "Enter your email and we'll send a magic link — no password to remember.",
    cta: "Send magic link",
  },
  signup: {
    title: "Create your account",
    subtitle:
      "Talk through any topic out loud and watch Curio build the board with you.",
    cta: "Send magic link",
  },
};

export function AuthForm({ mode }: AuthFormProps) {
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  // Surface any error the callback bounced back via ?error=...
  const callbackError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const copy = COPY[mode];
  const orbState: OrbState = status === "sending" ? "connecting" : "idle";

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;

    setError(null);
    setStatus("sending");

    try {
      const supabase = createClient();
      const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo,
          shouldCreateUser: true,
          ...(mode === "signup"
            ? { data: { display_name: displayName.trim() } }
            : {}),
        },
      });

      if (otpError) {
        setError(otpError.message);
        setStatus("idle");
        return;
      }

      setStatus("sent");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
      setStatus("idle");
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Orb
          state={orbState}
          interactive={false}
          className="auth-orb"
          ariaLabel="Curio"
        />

        {status === "sent" ? (
          <div className="auth-sent">
            <div className="auth-wordmark">Curio</div>
            <div className="auth-sent__title">Check your inbox</div>
            <p className="auth-sent__body">
              We sent a magic link to{" "}
              <span className="auth-sent__email">{email.trim()}</span>. Open it
              on this device to finish signing in.
            </p>
            <button
              type="button"
              className="auth-ghost-btn"
              onClick={() => setStatus("idle")}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <>
            <div className="auth-header">
              <div className="auth-wordmark">Curio</div>
              <h1 className="auth-title">{copy.title}</h1>
              <p className="auth-subtitle">{copy.subtitle}</p>
            </div>

            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              {mode === "signup" && (
                <div className="auth-field">
                  <label className="auth-label" htmlFor="auth-name">
                    Display name
                  </label>
                  <input
                    id="auth-name"
                    className="auth-input"
                    type="text"
                    autoComplete="name"
                    placeholder="Ada Lovelace"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                  />
                </div>
              )}

              <div className="auth-field">
                <label className="auth-label" htmlFor="auth-email">
                  Email
                </label>
                <input
                  id="auth-email"
                  className="auth-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@school.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus={mode === "login"}
                />
              </div>

              {(error ?? callbackError) && (
                <div className="auth-error" role="alert">
                  {error ?? callbackError}
                </div>
              )}

              <button
                type="submit"
                className="auth-submit"
                disabled={status === "sending"}
              >
                {status === "sending" ? "Sending…" : copy.cta}
              </button>
            </form>

            <div className="auth-foot">
              {mode === "login" ? (
                <>
                  New here?{" "}
                  <Link className="auth-link" href="/signup">
                    Sign up
                  </Link>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <Link className="auth-link" href="/login">
                    Log in
                  </Link>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
