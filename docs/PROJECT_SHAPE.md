# How Atelier shapes a project

This is the contract between the founder, Drafter, and Implementer. Read once
at project start; reference any time things feel like they're growing
laterally without a backbone.

The principle: **a project is not a list of tasks. It is a hierarchy of
altitudes.** Every node lives at exactly one altitude and is rooted in the
altitude above it. Fruits don't grow in air.

---

## The 6 altitudes

```
Layer       — infra | middle | application                       (set once at project start)
Plane       — frontend | backend | data | integration | cross-cutting
Surface     — now, canvas, agents, brain, settings, world, …    (the founder's daily-driver vocabulary)
Story | Epic
              Story = feature, ask, capability                 (forward-looking)
              Epic  = issue, bug, regression, refactor         (backward-looking — fixes shipped work)
Task        — one concrete executable unit                       (Implementer runs only at this altitude)
Subtask     — atomic step inside a Task when needed              (rare; only for genuinely multi-step Tasks)
```

Each altitude is the parent of the next. A new ask **always** lands at altitude
4 (Story or Epic) and roots upward into existing Surface → Plane → Layer.
If the upward roots don't exist, Drafter proposes them first; founder approves;
the work follows.

### Authoring discipline per altitude

| Altitude   | Who authors                       | When                                           | What it carries                                             |
|------------|-----------------------------------|------------------------------------------------|-------------------------------------------------------------|
| Layer      | founder, during onboarding        | once per project                               | a single tag                                                |
| Plane      | Drafter proposes, founder approves| a few times per project lifetime               | name, surface_kind, parent Layer                            |
| Surface    | Drafter proposes, founder approves| 10–30 per project                              | name, parent Plane, manifest_globs (file patterns it owns)  |
| Story/Epic | Drafter (in conversation w/ founder) | continuously                                | intent, who_benefits, acceptance, touches: [Surface…]       |
| Task       | Drafter decomposes from Story/Epic| continuously                                   | planned_artifacts, depends_on, touches inherited from parent |
| Subtask    | Drafter, only if Task is genuinely multi-step | rare                              | same shape as Task, just nested                             |

### Convergence rules (enforced by code)

- A Task cannot be `state: approved` if its `touches` array is empty or any
  touched Surface is still `proposed`.
- A Surface cannot exist without a `parent_plane_id`.
- A Plane cannot exist without a parent Project's `layer` field set.
- Any `Planned artifact` path on a Task must fall within at least one of the
  parent Story/Epic's touched Surfaces' `manifest_globs`. The Implementer's
  hallucination guard rejects writes outside that allowed set.
- When a Surface is edited (rename, manifest change, retire), every node
  touching it gets a `surface-edited` badge and reads the change-summary
  Drafter writes. If retired, all touching nodes transition to `state: blocked`
  with `reason: surface retired — re-place this work` until founder reassigns.

These rules are why the project converges. Every claim of "I'm working on X"
is rooted in a Surface, a Plane, a Layer. Investor / new-hire / future-you
opens `/canvas → shape` and sees the silhouette.

---

## Where new asks land — the flow

When the founder discusses an ask in a Now session:

1. **Drafter classifies.** Story (feature/ask/capability) or Epic (regression/bug/refactor)?
2. **Drafter places.** Identifies the touched Surface(s). If unclear:
   - Run a quick read of related code → propose a candidate Surface to the founder in chat.
   - If the founder agrees → propose a Surface node, link the Story to it.
   - If a whole Plane is missing (e.g., first time a project touches `data`) → escalate to founder with structured `blocked_on_founder` payload.
3. **Drafter pre-emit smoke check** before Tasks are emitted from a Story:
   - Are the planned_artifacts paths inside the Surface's manifest?
   - Do existing files in those paths support the change without breaking imports?
   - Does any Acceptance bullet require a tool/library not currently present?
   - Does this conflict with a recent Decision node?
   If any check fails → revise plan in place, or emit a Research node first, or
   escalate. **Drafter does not emit a broken-on-arrival Task.**
4. **Drafter assigns `lock_id`** at node creation: `s-1-t-7` (cycle-task) or
   sequential. Implementer queue orders by `(priority_score, lock_id)`.
5. **Drafter computes `priority_score`** (0.0–1.0) from:
   - dependency leverage (how many other Tasks depend on this)
   - Surface heat (recently-active Surfaces score higher)
   - semantic urgency (Drafter LLM-classifies founder tone)
   - blast radius (small touches preferred — reviewable diffs)
   - smoke-test runtime estimate
   - risk gate (auth/payments/legal/privacy → founder gate, regardless of score)
6. **Implementer picks up.** No founder click required for Tasks under the
   computed priority threshold. Continuous flow.

---

## Founder involvement — when, exactly

You are involved only when:

- **Architectural shifts**: new Layer, new Plane, retiring a Surface
- **Cross-cutting decisions** with multi-Surface blast radius and irreversible cost
- **Risk-gated Surfaces**: anything matching auth, payments, legal, data privacy keywords
- **Senior reviewer recommends** a Surface redesign or new Component proposal
  (after 2 smoke failures + senior reviewer auto-spawn)

Drafter explains in detail why each blocked-on-founder question can't be
auto-decided. Structured payload:

```yaml
blocked_on_founder:
  question: "..."
  why_drafter_cannot_decide: "..."
  options:
    - id: opt-a
      label: "..."
      cost: "..."
      risk: "..."
  recommended: opt-a
  recommended_why: "..."
```

You read this in Approvals (or in Now if the question fires mid-session). You
pick an option (or ask Drafter to elaborate any field). Drafter resumes; the
node moves to `approved` with your choice attached as a Decision node.

**You are never asked to set P0/P1 dials.** Priority is computed.

**You are never the first responder to a smoke failure.** Drafter is. Then
senior reviewer (when configured). Then you, only on architectural recommendation.

---

## Locking and the queue — continuous flow

- No conversation-level lock prompt at 25 tasks. Drafter assigns `lock_id` per
  node at creation; Implementer queue is always populated.
- A "session" or "cycle" is a narrative grouping (`s-1`, `s-2`, …) used in
  retrospective views (`/canvas → shape` shows "what we shipped this cycle").
- The queue runs in this preference order:
  1. priority_score (Drafter-computed, descending)
  2. lock_id (ascending — fairness across cycles)
  3. topological readiness (depends_on must be `done`)
  4. Surface heat tiebreaker (least-recently-touched Surface wins, prevents
     one-Surface dominance)
  5. smaller first (smaller diff scope wins ties)
  6. author_age (FIFO at the final tiebreaker — no starvation)
- Implementer is **always working** when there's a ready Task and Implementer
  mode is `auto` or `semi_auto`. The "founder pause" toggle in Settings is the
  explicit save-point if you want flow to stop.

### Supersession (the pivot mechanism)

If Drafter realizes a previously emitted Task was wrong:
- Drafter emits a successor Task with `supersedes: s-2-t-4` field.
- The original Task transitions to `state: superseded`.
- Implementer never works on superseded Tasks.
- Founder is notified only if the supersession changes the Surface's contract
  (an architectural shift gate).
- The chain of supersessions becomes audit log; the live Task is what's queued.

---

## Smoke failures — escape valves

```
Implementer runs Task
  ↓
qwen-code finishes
  ↓
hallucination guard: did write_file land for each Planned artifact?
  ↓ no
  ↓ retry once with corrective prompt
  ↓ still no
  ↓ → blocked, reason: hallucination guard tripped
  ↓ yes (files written)
  ↓
smoke check: tsc --noEmit on touched packages
  ↓ pass → state: review (or auto-approve in `auto` mode)
  ↓ fail
  ↓ retry once with corrective prompt + tsc output
  ↓ still fail
  ↓
threshold check:
  ↓ < 2 failures on this Task AND systemic failure rate < 3 of last 50
  ↓   → next-session-pass: Drafter notified at next Now session start
  ↓ ≥ 2 failures on this Task AND priority_score > 0.7 AND senior_reviewer auto-mode enabled
  ↓   → auto-spawn senior reviewer (cloud) → critique returned
  ↓     → if architectural recommendation → blocked_on_founder
  ↓     → else → Drafter amends Task plan, queue picks up retry
```

Founder sees these as queue items only when an architectural recommendation
emerges. Day-to-day smoke chatter stays between Drafter and Implementer.

---

## The `/canvas → shape` view

A new tab inside `/canvas`, alongside `radial / kanban` (the existing layout
toggles), positioned first because it's the architectural primer.

What it renders: the architectural skeleton only — Layer pills → Plane boxes →
Surface boxes — not Stories/Tasks. Click any Surface → side panel shows:
- manifest_globs (founder-editable inline)
- status (proposed / active / deprecated)
- recent Stories/Epics touching this Surface
- last 5 Tasks shipped
- Surface-heat indicator (recent change velocity)

This is the silhouette. New people open it and understand what the product
IS in 30 seconds.

Every node-detail panel (across canvas / backlog / shape side-panel) shows
the full breadcrumb chain at the top:

```
application › backend › canvas › Story "..."
```

You always know where the work lives.

---

## Settings — the founder's dials

Settings → Agents → Implementer:
- mode: `manual` / `semi_auto` / `auto` / `paused`
- senior_reviewer auto-spawn: `off` (default) / `on` — disclosed cost
- session_lock_threshold: `25` (default, range 5–100) — ignored under continuous
  flow but kept for retrospective-narrative purposes

Settings → Agents → Drafter:
- pre_emit_smoke_check_depth: `quick syntactic` (default) / `full semantic`
  — full-semantic only triggers on Tasks with priority_score > 0.7

Settings → Architecture (new):
- View / edit Layer
- Approve pending Planes
- Bootstrap mode: `on` for the first 5 Surfaces in a new project, then `off`

---

## What you do at each altitude — your own checklist

| Altitude | Your job |
|----------|----------|
| Layer    | Pick once during project onboarding |
| Plane    | Approve Drafter proposals (a few times per project) |
| Surface  | Approve Drafter proposals + edit manifest_globs as Surfaces evolve (10–30 over the project) |
| Story/Epic | Discuss with Drafter in Now → Drafter writes → you approve in Approvals if not auto-promoted |
| Task     | Drafter authors; Implementer runs; you review only on `state: review` (auto-approved when Drafter mode is `auto` and priority_score is above threshold) |
| Subtask  | Same as Task, rarely surfaced |

When you sit down for a Now session, your work is:
1. Tell Drafter what's on your mind
2. Answer Drafter's structured `blocked_on_founder` questions when they arise
3. Glance at `/canvas → shape` to confirm the silhouette is what you want
4. Glance at the activity feed on Home to see what shipped

Everything else is the agents.

---

## What this prevents

- Lateral ginger-style growth (no node lives without a chain up to Layer)
- Implementer stitching across Surface boundaries without intent
- Founder being asked low-stakes priority questions
- Blocked queues that stall on missing context
- Surface drift (silent code organization shifts that no one tracked)
- Drafter emitting Tasks against stale Surface state

## What this enables

- Continuous Implementer flow without founder bottleneck
- Architectural memory that compounds across cycles
- Investor / handoff readability from `/canvas → shape`
- Drafter and Implementer staying in sync via supersession + lock_id ordering
- Senior reviewer escalation only for architecture-level decisions
- Founder being the *judge*, not the *bottleneck*

---

_Read this once. Reference when things feel structurally off. The contract is
load-bearing — code enforces it. If a rule here turns out to be wrong, the
rule changes here first, then in code._
