import { useEffect, useState } from "react";
import { Particles } from "./Particles";
import { BASE_URL } from "../lib/api";

type Tab = "signin" | "request" | "forgot" | "reset";

/**
 * SignIn — four modes, one page:
 *
 *  1. Sign in        — email + password; returns cookie if account is approved.
 *  2. Request access — email + password + name; creates a pending user record.
 *                      The host must approve before sign-in works.
 *  3. Forgot         — submit email → backend emails a password-reset link.
 *  4. Reset          — landed via `?reset=<token>`; set a new password and sign
 *                      in immediately. Cookie is set on success.
 *
 *  Both signup and sign-in refuse strangers from entering the workspace. New
 *  users land in 'pending' status and only become usable after admin approval.
 *  The first user on a fresh box is auto-approved as the bootstrap admin.
 */
export function SignIn() {
  const [tab, setTab] = useState<Tab>("signin");

  // First-run detection: when host_exists=false, we're on a fresh install
  // and the user IS the admin. Default to register tab, hide signin tab,
  // and reframe the copy as "set up your install" rather than "ask to join".
  const [hostExists, setHostExists] = useState<boolean | null>(null);

  // Shared
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  // Bootstrap-window gate: revealed only when the backend answers 403 with
  // bootstrap_token_required (reachable install with 0 users).
  const [needsBootstrapToken, setNeedsBootstrapToken] = useState(false);
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [requestSubmitted, setRequestSubmitted] = useState<{ status: "approved" | "pending" } | null>(null);
  const [forgotSent, setForgotSent] = useState<{ email: string } | null>(null);

  // Reset-mode token, captured from `?reset=…` on mount.
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");

  function resetMessages() { setError(null); setHint(null); }

  // Probe install-state on mount. If no host exists yet, this is a fresh
  // install — default to the register tab and hide the signin tab. Safe
  // default on error is hostExists=true (existing-install signin UX).
  useEffect(() => {
    fetch(`${BASE_URL}/auth/install-state`)
      .then(r => r.json())
      .then(d => setHostExists(d.host_exists ?? true))
      .catch(() => setHostExists(true));
  }, []);

  // When we discover this is a fresh install, switch to the register tab
  // so the user lands on "set up your install" without an extra click.
  // Don't override if the user already opened the page via ?reset=<token>.
  useEffect(() => {
    if (hostExists === false) {
      setTab(prev => (prev === "reset" ? prev : "request"));
    }
  }, [hostExists]);

  // Detect ?reset=<token> on first render and flip into reset mode.
  // Removes the token from the URL bar so a refresh / back-button doesn't
  // re-replay or expose it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("reset");
    if (t) {
      setResetToken(t);
      setTab("reset");
      params.delete("reset");
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState({}, "", newUrl);
    }
  }, []);

  async function doSignIn(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const r = await fetch(`${BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password: password.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data?.error ?? `Sign-in failed (${r.status}).`);
        if (data?.status === "pending") setHint("Ask the host to approve your access request.");
        setBusy(false);
        return;
      }
      // Cookie is set; reload to land on /home with full session.
      window.location.assign("/home");
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  async function doRequest(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const r = await fetch(`${BASE_URL}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
          display_name: displayName.trim(),
          ...(bootstrapToken.trim() ? { bootstrap_token: bootstrapToken.trim() } : {}),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (data?.bootstrap_token_required) setNeedsBootstrapToken(true);
        setError(data?.error ?? `Request failed (${r.status}).`);
        setBusy(false);
        return;
      }
      if (data.first_user) {
        // First user on a fresh box — auto-approved. Cookie is set.
        // Route to "/?signin=admin" so App.tsx's onboarding-state branch
        // shows the onboarding wizard (route 5 in resolveAppState).
        window.location.assign("/?signin=admin");
        return;
      }
      setRequestSubmitted({ status: data.status === "approved" ? "approved" : "pending" });
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  async function doForgot(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const r = await fetch(`${BASE_URL}/auth/reset-password/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data?.error ?? `Request failed (${r.status}).`);
        setBusy(false);
        return;
      }
      setForgotSent({ email: email.trim() });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doConfirmReset(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    if (resetNewPassword !== resetConfirm) {
      setError("passwords don't match");
      return;
    }
    if (resetNewPassword.trim().length < 8) {
      setError("password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${BASE_URL}/auth/reset-password/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          token: resetToken,
          new_password: resetNewPassword.trim(),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data?.error ?? `Reset failed (${r.status}).`);
        setBusy(false);
        return;
      }
      window.location.assign("/home");
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  // ── shared input style ────
  const inputStyle: React.CSSProperties = {
    display: "block", width: "100%", marginTop: 6,
    padding: "12px 14px", fontFamily: "var(--font-sans)",
    fontSize: "0.96rem", letterSpacing: "normal",
    textTransform: "none", color: "var(--ink-0)",
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 8,
  };
  const labelStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)", fontSize: "0.7rem",
    letterSpacing: "0.14em", textTransform: "uppercase",
    color: "var(--ink-2)",
  };
  const formStyle: React.CSSProperties = {
    maxWidth: 460, margin: "0 auto", padding: "28px 28px 24px",
    borderRadius: 16, display: "flex", flexDirection: "column",
    gap: 14, textAlign: "left",
  };
  const linkButtonStyle: React.CSSProperties = {
    background: "transparent", border: 0, padding: 0,
    color: "var(--ink-2)", cursor: "pointer",
    fontFamily: "var(--font-mono)", fontSize: "0.74rem",
    letterSpacing: "0.08em", textTransform: "uppercase",
    textDecoration: "underline", textUnderlineOffset: 3,
  };

  const isFirstRun = hostExists === false;
  const heading =
    tab === "signin"  ? "Welcome back." :
    tab === "request" ? (isFirstRun ? "Set up your install." : "Ask to join.") :
    tab === "forgot"  ? "Forgot your password?" :
                        "Set a new password.";
  const eyebrow =
    tab === "signin"  ? "Sign in" :
    tab === "request" ? (isFirstRun ? "First-run setup" : "Request access") :
    tab === "forgot"  ? "Password reset" :
                        "Reset password";
  const lede =
    tab === "signin"
      ? "Email and password — nothing fancy. Cookie-based sessions, 30 days."
      : tab === "request"
      ? (isFirstRun
          ? "You're the first user on this install. Create your host account — you'll be auto-approved as admin."
          : "Submit a request. The host of this Atelier reviews and approves before you can sign in.")
      : tab === "forgot"
      ? "Tell us your email; we'll send a one-time link that lets you set a new password."
      : "Pick a new password. Once you save it you'll be signed in here automatically.";

  return (
    <div className="lp">
      <Particles className="lp-stars" count={220} linkDistance={92} speed={0.05} />
      <div className="lp-vignette" aria-hidden />

      <header className="lp-nav lp-glass">
        <div className="lp-mark">
          <span className="lp-mark-dot" />
          <span className="lp-mark-word">atelier</span>
        </div>
        <nav className="lp-nav-links" aria-label="Primary">
          <button onClick={() => window.location.assign("/")}>← Back</button>
        </nav>
      </header>

      <main className="lp-main" id="main-content">
      <section className="lp-hero" aria-label={eyebrow} style={{ paddingTop: 64 }}>
        <div className="lp-hero-eyebrow">{eyebrow}</div>
        <h1 className="lp-section-title" style={{ marginBottom: 18 }}>{heading}</h1>
        <p className="lp-hero-lede" style={{ marginBottom: 28 }}>{lede}</p>

        {/* Tab selector — hidden on reset (token-driven) and on first-run
            (no host yet → there's nobody to "sign in" as; show register only). */}
        {tab !== "reset" && !isFirstRun && (
          <div style={{
            maxWidth: 460, margin: "0 auto 20px",
            display: "flex", gap: 4, padding: 4, borderRadius: 10,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}>
            {([
              ["signin",  "Sign in"],
              ["request", "Request access"],
            ] as [Tab, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => { setTab(k); resetMessages(); setRequestSubmitted(null); setForgotSent(null); }}
                style={{
                  flex: 1,
                  padding: "9px 8px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  border: "1px solid transparent",
                  borderRadius: 6,
                  color: tab === k ? "var(--ink-0)" : "var(--ink-2)",
                  background: tab === k ? "rgba(232,144,96,0.14)" : "transparent",
                  borderColor: tab === k ? "rgba(232,144,96,0.30)" : "transparent",
                }}
              >{label}</button>
            ))}
          </div>
        )}

        {/* SIGN IN */}
        {tab === "signin" && (
          <form onSubmit={doSignIn} className="lp-glass-strong" style={formStyle}>
            <label style={labelStyle}>
              Email
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus style={inputStyle} placeholder="you@example.com" />
            </label>
            <label style={labelStyle}>
              Password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required style={inputStyle} placeholder="••••••••" />
            </label>
            {error && <FormError error={error} hint={hint} />}
            <button type="submit" className="lp-cta-primary" disabled={busy} style={{ justifyContent: "center", marginTop: 4 }}>
              <span>{busy ? "Signing in…" : "Sign in"}</span>
              <span className="lp-cta-arrow">→</span>
            </button>
            <div style={{ textAlign: "center", marginTop: 6 }}>
              <button
                type="button"
                onClick={() => { setTab("forgot"); resetMessages(); setForgotSent(null); }}
                style={linkButtonStyle}
              >Forgot password?</button>
            </div>
          </form>
        )}

        {/* REQUEST ACCESS */}
        {tab === "request" && !requestSubmitted && (
          <form onSubmit={doRequest} className="lp-glass-strong" style={formStyle}>
            <label style={labelStyle}>
              Your name
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} required autoFocus style={inputStyle} placeholder="how the host knows you" />
            </label>
            <label style={labelStyle}>
              Email
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required style={inputStyle} placeholder="you@example.com" />
            </label>
            <label style={labelStyle}>
              Choose a password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} style={inputStyle} placeholder="at least 8 characters" />
            </label>
            {needsBootstrapToken && (
              <label style={labelStyle}>
                First-run token
                <input type="text" value={bootstrapToken} onChange={e => setBootstrapToken(e.target.value)} required style={inputStyle} placeholder="bt_… (printed at backend start · data/.bootstrap-token)" />
              </label>
            )}
            {error && <FormError error={error} hint={hint} />}
            <button type="submit" className="lp-cta-primary" disabled={busy} style={{ justifyContent: "center", marginTop: 4 }}>
              <span>{busy
                ? (isFirstRun ? "Creating…" : "Submitting…")
                : (isFirstRun ? "Create host account" : "Submit request")}</span>
              <span className="lp-cta-arrow">→</span>
            </button>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: "0.66rem",
              letterSpacing: "0.08em", color: "var(--ink-3)",
              textTransform: "uppercase", textAlign: "center", marginTop: 4,
            }}>
              {isFirstRun
                ? "Auto-approved as admin · Argon2id hashed"
                : "Pending until approved · Argon2id hashed"}
            </div>
          </form>
        )}

        {tab === "request" && requestSubmitted && (
          <Submitted email={email.trim()} status={requestSubmitted.status} />
        )}

        {/* FORGOT — request a reset link */}
        {tab === "forgot" && !forgotSent && (
          <form onSubmit={doForgot} className="lp-glass-strong" style={formStyle}>
            <label style={labelStyle}>
              Email
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus style={inputStyle} placeholder="you@example.com" />
            </label>
            {error && <FormError error={error} hint={hint} />}
            <button type="submit" className="lp-cta-primary" disabled={busy} style={{ justifyContent: "center", marginTop: 4 }}>
              <span>{busy ? "Sending…" : "Send reset link"}</span>
              <span className="lp-cta-arrow">→</span>
            </button>
            <div style={{ textAlign: "center", marginTop: 6 }}>
              <button
                type="button"
                onClick={() => { setTab("signin"); resetMessages(); }}
                style={linkButtonStyle}
              >← Back to sign in</button>
            </div>
          </form>
        )}

        {tab === "forgot" && forgotSent && (
          <div className="lp-glass-strong" style={{
            maxWidth: 540, margin: "0 auto", padding: "32px 28px",
            borderRadius: 16, textAlign: "left", color: "var(--ink-0)",
          }}>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: "0.7rem",
              letterSpacing: "0.16em", textTransform: "uppercase",
              color: "var(--violet-2)", marginBottom: 14,
            }}>Check your inbox</div>
            <p style={{
              fontFamily: "var(--font-serif)", fontSize: "1.05rem",
              lineHeight: 1.6, color: "var(--ink-0)", marginBottom: 14,
            }}>
              If an account exists for <b>{forgotSent.email}</b>, a one-time reset
              link is on its way. The link expires in 30 minutes.
            </p>
            <p style={{ marginBottom: 0 }}>
              <button
                type="button"
                onClick={() => { setTab("signin"); resetMessages(); setForgotSent(null); }}
                style={linkButtonStyle}
              >← Back to sign in</button>
            </p>
          </div>
        )}

        {/* RESET — landed from email link, set new password */}
        {tab === "reset" && (
          <form onSubmit={doConfirmReset} className="lp-glass-strong" style={formStyle}>
            <label style={labelStyle}>
              New password
              <input
                type="password"
                value={resetNewPassword}
                onChange={e => setResetNewPassword(e.target.value)}
                required minLength={8} autoFocus
                style={inputStyle}
                placeholder="at least 8 characters"
              />
            </label>
            <label style={labelStyle}>
              Confirm new password
              <input
                type="password"
                value={resetConfirm}
                onChange={e => setResetConfirm(e.target.value)}
                required minLength={8}
                style={inputStyle}
                placeholder="type it again"
              />
            </label>
            {error && <FormError error={error} hint={hint} />}
            <button type="submit" className="lp-cta-primary" disabled={busy || !resetToken} style={{ justifyContent: "center", marginTop: 4 }}>
              <span>{busy ? "Saving…" : "Save and sign in"}</span>
              <span className="lp-cta-arrow">→</span>
            </button>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: "0.66rem",
              letterSpacing: "0.08em", color: "var(--ink-3)",
              textTransform: "uppercase", textAlign: "center", marginTop: 4,
            }}>
              All other sessions will be signed out
            </div>
          </form>
        )}

      </section>
      </main>
    </div>
  );
}

function FormError({ error, hint }: { error: string; hint: string | null }) {
  return (
    <div style={{
      fontFamily: "var(--font-mono)", fontSize: "0.74rem",
      color: "#f43f5e", lineHeight: 1.5,
    }}>
      {error}
      {hint && (
        <div style={{
          color: "var(--ink-2)", marginTop: 6,
          fontFamily: "var(--font-serif)", fontStyle: "italic",
          fontSize: "0.85rem", textTransform: "none", letterSpacing: "normal",
        }}>{hint}</div>
      )}
    </div>
  );
}

function Submitted({ email, status }: {
  email: string;
  status: "approved" | "pending";
}) {
  return (
    <div className="lp-glass-strong" style={{
      maxWidth: 540, margin: "0 auto", padding: "32px 28px",
      borderRadius: 16, textAlign: "left", color: "var(--ink-0)",
    }}>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: "0.7rem",
        letterSpacing: "0.16em", textTransform: "uppercase",
        color: "var(--violet-2)", marginBottom: 14,
      }}>Request submitted</div>
      <p style={{
        fontFamily: "var(--font-serif)", fontSize: "1.05rem",
        lineHeight: 1.6, color: "var(--ink-0)", marginBottom: 0,
      }}>
        {status === "approved"
          ? <>Welcome — your account was auto-approved (this is a fresh Atelier instance). You can sign in now.</>
          : <>Thanks. Your request for <b>{email}</b> is pending approval. The host will review it; you'll be able to sign in once approved.</>}
      </p>
    </div>
  );
}

export default SignIn;
