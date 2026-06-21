"use client";

/**
 * Auth form shared by /login and /signup.
 *
 * PRIMARY: email + password.
 *   - login  → `supabase.auth.signInWithPassword` → hard-nav to `next`.
 *   - signup → `supabase.auth.signUp` (+ display_name in user metadata).
 *       · email confirmation OFF → a session comes back → straight to `next`.
 *       · email confirmation ON  → no session → show "confirm your email".
 *
 * SECONDARY: magic link (kept as an option). `signInWithOtp` with
 * `emailRedirectTo` → our PKCE callback runs `exchangeCodeForSession`.
 *
 * On password success we do a full navigation (`window.location.assign`) rather
 * than a client push so the proxy/server picks up the freshly-written session
 * cookie on the next request.
 *
 * Visual language: the Orb hero + the .auth-* classes in app/auth/auth.css.
 */

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Orb, type OrbState } from "@/components/whiteboard/Orb";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "signup";
type Status = "idle" | "working";
type Sent = { kind: "magic" | "confirm"; email: string } | null;

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
    subtitle: "Log in with your email and password.",
    cta: "Log in",
  },
  signup: {
    title: "Create your account",
    subtitle:
      "Think out loud and watch a harness of agents build the board with you.",
    cta: "Create account",
  },
};

export function AuthForm({ mode }: AuthFormProps) {
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  // Surface any error the callback bounced back via ?error=...
  const callbackError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [sent, setSent] = useState<Sent>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = COPY[mode];
  const orbState: OrbState = status === "working" ? "connecting" : "idle";
  const working = status === "working";

  // ── Primary: email + password ──────────────────────────────────────────────
  async function handlePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (working) return;
    setError(null);
    setStatus("working");

    try {
      const supabase = createClient();
      const cleanEmail = email.trim();

      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: cleanEmail,
          password,
        });
        if (signInError) {
          setError(signInError.message);
          setStatus("idle");
          return;
        }
        window.location.assign(next);
        return;
      }

      // signup
      const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          emailRedirectTo,
          data: { display_name: displayName.trim() },
        },
      });
      if (signUpError) {
        setError(signUpError.message);
        setStatus("idle");
        return;
      }

      // Confirmation OFF → session present → go straight in.
      if (data.session) {
        window.location.assign(next);
        return;
      }
      // Confirmation ON → must verify email first.
      setSent({ kind: "confirm", email: cleanEmail });
      setStatus("idle");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
      setStatus("idle");
    }
  }

  // ── Secondary: magic link ──────────────────────────────────────────────────
  async function handleMagicLink() {
    if (working) return;
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError("Enter your email first, then request a magic link.");
      return;
    }
    setError(null);
    setStatus("working");

    try {
      const supabase = createClient();
      const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
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
      setSent({ kind: "magic", email: cleanEmail });
      setStatus("idle");
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

        {sent ? (
          <div className="auth-sent">
            <div className="auth-wordmark">Curio</div>
            <div className="auth-sent__title">
              {sent.kind === "magic" ? "Check your inbox" : "Confirm your email"}
            </div>
            <p className="auth-sent__body">
              {sent.kind === "magic" ? (
                <>
                  We sent a magic link to{" "}
                  <span className="auth-sent__email">{sent.email}</span>. Open it
                  on this device to finish signing in.
                </>
              ) : (
                <>
                  We sent a confirmation link to{" "}
                  <span className="auth-sent__email">{sent.email}</span>. Click it
                  to activate your account, then log in.
                </>
              )}
            </p>
            <button
              type="button"
              className="auth-ghost-btn"
              onClick={() => setSent(null)}
            >
              Back
            </button>
          </div>
        ) : (
          <>
            <div className="auth-header">
              <div className="auth-wordmark">Curio</div>
              <h1 className="auth-title">{copy.title}</h1>
              <p className="auth-subtitle">{copy.subtitle}</p>
            </div>

            <form className="auth-form" onSubmit={handlePassword} noValidate>
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

              <div className="auth-field">
                <label className="auth-label" htmlFor="auth-password">
                  Password
                </label>
                <input
                  id="auth-password"
                  className="auth-input"
                  type="password"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  placeholder={
                    mode === "signup" ? "At least 6 characters" : "Your password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>

              {(error ?? callbackError) && (
                <div className="auth-error" role="alert">
                  {error ?? callbackError}
                </div>
              )}

              <button type="submit" className="auth-submit" disabled={working}>
                {working ? "Working…" : copy.cta}
              </button>
            </form>

            <button
              type="button"
              className="auth-ghost-btn auth-magic-btn"
              onClick={handleMagicLink}
              disabled={working}
            >
              Prefer a magic link? Email me one instead
            </button>

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
