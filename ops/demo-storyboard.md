# Demo Recording Storyboard — Decompose → Approve → Build Loop

**Target output:** `docs/demo/demo-loop.gif` (900px wide, ≤60s, ≤4MB)
**Recording helper:** `ops/record-demo.sh`
**Prereqs:** App running (`npm run dev`), Claude authenticated, a test project open

---

## Scene 0 — Setup (before recording)

1. Open browser at `http://localhost:5174`
2. Navigate to **Now** view — you should see the terminal/chat panel
3. Resize window to exactly 1280×800 (script sets this geometry for ffmpeg)
4. Ensure the terminal is showing the agent prompt (not mid-session output)
5. Open a second tab at **Canvas** — confirm it's empty or has the test project loaded
6. Run `ops/record-demo.sh` and follow its prompts

---

## Scene 1 — Vague ask (4 s)

**View:** Now (terminal — ttyd/xterm.js, not a chat form)

**Action:** Click inside the terminal to focus it, then type the following ask slowly:

```
fix the chat input so it clears after send and shows a spinner while the agent is thinking
```

**Hit Enter.** The terminal shows Claude receiving the task. The agent (Drafter) begins decomposing.

**Pause 2s** to let the decomposition start before switching views.

---

## Scene 2 — Canvas loads with decomposed nodes (8 s)

**Action:** Click the **Canvas** tab in the sidebar.

**What should appear:** 3 plan-nodes created by Drafter, each showing:
- `[1] Clear input after send` — intent, who-it-helps ("founder won't re-read stale text"), acceptance criteria ("input is empty 200ms after Enter")
- `[2] Spinner on agent thinking` — intent, acceptance criteria ("spinner visible within 100ms, gone on first token")
- `[3] Empty-submit guard` — intent ("prevent accidental blank sends")

**Pause 3s** on the canvas so viewers can read the nodes.

---

## Scene 3 — Founder reviews and approves (10 s)

**Two options — pick whichever applies to your recording session:**

### Option A — Canvas approval (always works, even on first run)

Stay on **Canvas**. The founder reads the decomposed nodes, then navigates back to **Now** and types an approval instruction into the terminal:

```
looks good — proceed with nodes 1 and 2; skip the empty-submit guard for now
```

Hit Enter. The Implementer picks up the approved work.

### Option B — Approvals tab (requires a prior session with agent verifier failures)

Navigate to **Approvals** tab. If a prior run produced verifier constraints, they appear as cards with **accept** / **reject** buttons (not "Approve" / "Defer" — those are not the actual button labels).

1. Click **accept** on constraint 1 — card disappears
2. Click **accept** on constraint 2 — card disappears
3. Click **reject** on constraint 3 — card greys out

**Note:** On a first recording with no prior agent sessions, the Approvals list is empty. Use Option A instead.

**Pause 1s** after each action. Total ~6s.

---

## Scene 4 — Implementer runs (12 s)

**Action:** The Implementer should auto-start on the approved nodes. Navigate to **Now** or the terminal.

The terminal shows Claude making edits — file paths and diffs scrolling by (`frontend/src/views/Chat.tsx`, `frontend/src/components/...`).

**Let it run for 8–10s.** Capture the diff lines appearing.

---

## Scene 5 — Done state (4 s)

**Action:** When the agent stops, navigate to **Canvas**.

The two approved nodes show a ✓ completed state. The deferred node remains queued.

**Pause 2s.**

---

## Editing notes

- Total target runtime: ~38s (trim aggressively in scene 4 if agent is slow)
- Use `ops/record-demo.sh` to capture; it auto-converts to GIF
- If the Drafter produces different node names that's fine — the structure (decompose → approve → build) is what matters
- Keep the window focused on the Atelier browser tab throughout; avoid revealing OS chrome
