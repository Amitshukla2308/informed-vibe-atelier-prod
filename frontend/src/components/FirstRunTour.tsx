/**
 * FirstRunTour — one-shot welcome modal for a freshly authed founder.
 *
 * Trigger conditions (decided by the parent):
 *   - founder is authed and on /home
 *   - localStorage `atelier.tour.dismissed` is not "1"
 *   - no project exists, OR the active project has zero canvas nodes
 *   - URL does not have ?qa=1 (used by Playwright runs)
 *
 * Dismissal is sticky: once the user clicks "got it" or the X, we set
 * localStorage and never show it again on this device. There is no server-
 * side persistence — this is a per-device first-impression nudge, not a
 * gating fixture.
 */

import { useState } from "react";

const STORAGE_KEY = "atelier.tour.dismissed";

export function isTourDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissTour(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch { /* private mode — silently ignore; tour will re-show next nav */ }
}

interface Step {
  kicker: string;
  title: string;
  body: string;
  cta?: { label: string; onClick: () => void };
}

interface Props {
  onClose: () => void;
  onGoto?: (view: "canvas" | "brain" | "approvals" | "world" | "reflect" | "settings") => void;
}

export function FirstRunTour({ onClose, onGoto }: Props) {
  const [step, setStep] = useState(0);

  const steps: Step[] = [
    {
      kicker: "welcome",
      title: "This is your atelier.",
      body: "A workspace for one founder and an AI co-founder. It learns from every conversation, drafts a plan you can see and edit on a canvas, then ships parts of it when you say go.",
    },
    {
      kicker: "step 1 of 3",
      title: "Tell the agent your project.",
      body: "Open Now and say what you're trying to build — out loud, like you would to a smart friend. The agent listens, takes notes, and starts drafting.",
      cta: { label: "open now →", onClick: () => { dismissTour(); window.location.hash = "#/now"; onClose(); } },
    },
    {
      kicker: "step 2 of 3",
      title: "Watch the canvas fill.",
      body: "As the agent thinks, it places nodes on the canvas — features, decisions, open questions. Nothing lands on disk without your approval. This is the spatial brain.",
      cta: { label: "open canvas →", onClick: () => { dismissTour(); onGoto?.("canvas"); onClose(); } },
    },
    {
      kicker: "step 3 of 3",
      title: "Approve a node to ship.",
      body: "When a node is ready, the implementer agent picks it up and writes the code. You get a diff to review. You stay in command — the agent ships only what you greenlight.",
      cta: { label: "got it", onClick: () => { dismissTour(); onClose(); } },
    },
  ];

  const s = steps[step];
  const last = step === steps.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="atelier-tour-title"
      onClick={(e) => { if (e.target === e.currentTarget) { dismissTour(); onClose(); } }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: "var(--a-paper, #0c1219)",
          border: "1px solid var(--a-line, #1f2937)",
          borderRadius: 6,
          maxWidth: 540,
          width: "100%",
          padding: "28px 28px 22px",
          fontFamily: "var(--font-mono)",
          color: "var(--a-ink, #e6e8eb)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          position: "relative",
        }}
      >
        <button
          type="button"
          aria-label="Close welcome tour"
          onClick={() => { dismissTour(); onClose(); }}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            background: "transparent",
            border: "none",
            color: "var(--a-mute, #6b7280)",
            cursor: "pointer",
            fontSize: 18,
            lineHeight: 1,
            padding: 6,
          }}
        >×</button>

        <div style={{ fontSize: "var(--t-1)", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--a-mute)", marginBottom: 8 }}>
          {s.kicker}
        </div>
        <h2 id="atelier-tour-title" style={{ fontFamily: "var(--font-serif)", fontSize: "var(--t-4)", fontWeight: 600, margin: "0 0 12px", lineHeight: 1.25 }}>
          {s.title}
        </h2>
        <p style={{ fontSize: "var(--t-2)", color: "var(--a-ink-2, #cbd5e1)", lineHeight: 1.55, margin: "0 0 24px" }}>
          {s.body}
        </p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", gap: 6 }} aria-hidden="true">
            {steps.map((_, i) => (
              <span
                key={i}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: i === step ? "var(--a-accent, #4cb5ff)" : "var(--a-line-2, #2d3a4a)",
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--a-line)",
                  color: "var(--a-mute)",
                  padding: "6px 12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-1)",
                  textTransform: "lowercase",
                  borderRadius: 3,
                  cursor: "pointer",
                }}
              >back</button>
            )}
            {!last && !s.cta && (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                style={{
                  background: "var(--a-accent, #4cb5ff)",
                  border: "1px solid var(--a-accent, #4cb5ff)",
                  color: "var(--a-paper, #0c1219)",
                  padding: "6px 14px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-1)",
                  textTransform: "lowercase",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >next →</button>
            )}
            {s.cta && (
              <button
                type="button"
                onClick={() => { s.cta!.onClick(); }}
                style={{
                  background: "var(--a-accent, #4cb5ff)",
                  border: "1px solid var(--a-accent, #4cb5ff)",
                  color: "var(--a-paper, #0c1219)",
                  padding: "6px 14px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-1)",
                  textTransform: "lowercase",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >{s.cta.label}</button>
            )}
            {!s.cta && step < steps.length - 1 && (
              <button
                type="button"
                onClick={() => { dismissTour(); onClose(); }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--a-mute)",
                  padding: "6px 6px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-1)",
                  textTransform: "lowercase",
                  cursor: "pointer",
                }}
              >skip</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
