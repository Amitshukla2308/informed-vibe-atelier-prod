# Informed Vibe Atelier — Vision

> **Informed Vibe Atelier is a working environment for small founding teams where an AI co-founder receives direction from both technical and non-technical founders, works autonomously between sessions, and gives each person the right level of visibility and control.**

This document is the canonical reference for what Atelier *is* — the founder's app, the full feature surface, the dual-founder model, the agent framing, the proving-ground discipline.

---

## Why This Exists

Most people using AI tools today are either over-trusting (letting the model make decisions they can't verify) or under-trusting (dismissing it and falling behind). The middle ground — **informed, controlled, effective AI collaboration** — is almost entirely uncharted for non-experts.

The people who get disproportionate value from LLMs share a small set of habits:

- They give the AI **domain context** (what industry, what laws, what customers) before asking it to write code.
- They impose **scope gates** (no building without a pre-flight doc that answers: how will users find this?).
- They enforce **resource consciousness** (not every problem needs exploration; *enough for now* is a discipline).
- They demand **production defaults** (async processing, no silent failures, working user journeys before "done").
- They build **real visibility** for themselves (not log archaeology — a proper interface).
- They retain **appropriate control** (approve decisions, not micromanage implementation).

Informed Vibe Atelier is the demonstration that this middle ground exists and is buildable as a product, not just a personal practice.

---

## What Drove the Design

A common pattern, observed repeatedly: an autonomous coding agent is given a goal and full latitude. In two days it consumes a week's API quota and produces:

- Dozens of duplicate report files
- Multiple parallel implementations of the same dashboard
- Features that exist as routes but have no working user journey
- A "100% accurate" audit tool that fails on real documents due to a truncation bug
- Silent runtime errors in code paths nobody exercised
- Quantity over quality. Hard worker, not smart worker.

The root cause: **the agent had capability without constraints.** It was rewarded for coherence (well-structured plans, readable code) not for correctness (a real user completes a real task without error). It drowned in the ocean of knowledge and lost sight of being a founder.

The fix is not a smarter model. The fix is the working environment around the model — domain brain, scope gates, resource governor, approvals queue, visibility for both technical and non-technical humans.

That working environment is Atelier.

---

## The Product Insight

Every small founding team has the same problem:

- The technical co-founder is time-constrained (often has a day job or split focus).
- The non-technical co-founder knows the market but can't contribute to the build.
- There is no good way for both to direct AI work and understand what it's doing.

Atelier is the answer to that problem.

It is **not**:
- Another agent framework (CrewAI, AutoGen, LangChain — too technical, no UX)
- Another AI coding assistant (Claude Code, Cursor — too narrow, coding only)
- Another startup OS (Notion, Linear — no AI agency)

It **is**:
- A **control plane** for an autonomous AI agent that thinks like a founder
- Powered by **domain intelligence** (the agent knows your industry before writing code)
- Powered by **codebase intelligence** (temporal co-change, blast radius, ownership signals)
- Accessible to **both technical and non-technical founders** through role-based views
- Built on the **lessons of real experiments**, not theoretical best practices

---

## The Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ATELIER INTERFACE                     │
│   Technical view (founder/dev) | Business view (ops)    │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                   AGENT RUNTIME                          │
│   Workloop · Multi-persona thinking · Resource governor  │
│   Scope gates · Domain brain · Hygiene protocol          │
└──────┬──────────────────────────────────────┬───────────┘
       │                                      │
┌──────▼──────────┐                  ┌────────▼────────────┐
│ DOMAIN BRAIN    │                  │ CODEBASE INTELLIGENCE│
│ Industry wiki   │                  │ Temporal co-change   │
│ Success/failure │                  │ Blast radius         │
│ Current market  │                  │ Ownership decay      │
│ Viability check │                  │ Critical-path signal │
└─────────────────┘                  └─────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                  LLM PROVIDER                            │
│   Pluggable: Claude / Gemini / OpenAI / local           │
└─────────────────────────────────────────────────────────┘
```

`{{agent_name}}` is the reference agent persona running on this stack. The stack is Atelier; the persona is configurable per workspace.

---

## User Model — The Datum

The onboarding flow is not just setup. It is the **datum** — the starting point that shapes everything. The questions asked during onboarding are the same questions a founder should answer before building anything.

### Onboarding Flow

```
Login / First time
      │
      ▼
Are you setting up a new workspace?
      │
      ├── Yes → ADMIN SETUP
      │           Define org
      │           Connect LLM provider (API key / subscription / local)
      │           Create first project
      │           Invite team members with roles
      │
      └── No  → SELECT ORG + ROLE
                  → Your curated view loads
```

### Roles and What They See

| Role | What They See | What They Can Do |
|---|---|---|
| **Admin** | Full system: all views, logs, config, LLM settings, all projects | Everything |
| **Technical Founder** | Logs, architecture decisions, code context, domain brain (technical layer), resource meters | Approve technical decisions, redirect agent, view codebase intelligence |
| **Business Founder** | Plain language status, market questions, pricing decisions, customer context, what shipped | Approve business decisions, contribute to domain brain (market layer), message agent |
| **Developer** | Code-focused: PRs, blast radius, test status, technical approvals | Code review, technical approvals |
| **Analyst** | Data layer: metrics, domain brain research, competitive landscape | Research contributions, read-only on agent |

### Org → Projects → Agent

```
Admin
  └── Org
       ├── Users + Roles
       ├── LLM Config
       └── Projects
            └── Project
                 ├── Domain Brain  (industry wiki for this project)
                 ├── Agent         ({{agent_name}} instance)
                 ├── Codebase      (intelligence index)
                 └── Views         (role-curated)
```

---

## Atelier Interface — Views

### Navigation (left sidebar, all roles see relevant subset)

| View | Technical | Business | Admin |
|---|---|---|---|
| **Now** | Full logs + resource strip | Plain status card + "what is it doing" | Full |
| **Approvals** | Technical decisions pending | Business decisions pending | All pending |
| **Projects** | Scope doc, phase, last commit, user journey status | What's being built, why, when it ships | Full |
| **Domain Brain** | Technical layer: APIs, architecture, competitive tech | Market layer: customers, pricing, competitors | Full |
| **Backlog** | Kanban with technical detail | Kanban with plain language | Full |
| **Reports** | Session summaries: tokens used, gates passed, what shipped | Business summaries: features shipped, user journey status | Full |
| **Health** | RAM, VRAM, disk, API quota | "System healthy / attention needed" | Full |
| **Terminal** | Embedded xterm.js — start/stop agent | Hidden | Full |

### The Terminal Question

Yes — embedded terminal (xterm.js + node-pty over WebSocket). The technical founder starts the agent daemon from inside Atelier. Once running, everything else is Atelier. No need to switch windows.

### The Async Rhythm (designed for real founder schedules)

```
Evening (technical founder, ~30 min):
  → Review what the agent did today
  → Approve/redirect next scope
  → See if co-founder left any business input

Overnight (agent autonomous):
  → Works on approved scope
  → Routes business questions to the co-founder's view
  → Routes technical blockers to the technical founder's approvals

Morning (business co-founder, ~10 min):
  → Opens Atelier, sees plain-language update
  → Answers any business questions in queue
  → Adds market observations to domain brain

Day (technical founder elsewhere, agent working):
  → Async: co-founder inputs flow to agent
  → Critical blocks → notification to technical founder
  → Non-critical continues without interruption
```

---

## The Domain Brain — Before Any Code

For every new project, before the agent writes a single line of code, it builds a domain brain. This is not optional. It is the gate.

### Structure

```
projects/<project>/domain_brain/
  industry_map.md       — How the industry works, key players, business models
  success_stories.md    — What worked, under what conditions, why (temporal)
  failure_stories.md    — What failed, under what conditions, why (temporal)
  current_conditions.md — What is true NOW: policy, competition, buyer behavior
  customer_personas.md  — Who the actual user is (contributed by business founder)
  open_questions.md     — What we don't know yet, needs human input
  viability_verdict.md  — "Is this worth building now?" Evidence-based, honest
```

The `viability_verdict.md` ends with a direct question to the founding team: *Based on this research, my honest assessment is X. Here is what I am uncertain about. Is this worth building?*

**No greenlight = no build.**

The domain brain forces the agent to surface what it doesn't know **before** it writes code that depends on what it doesn't know. This single discipline eliminates a large class of "looks correct, fails in reality" failures.

---

## The Agent — `{{agent_name}}`

The agent persona is templated. Each Atelier workspace configures `{{agent_name}}` at install time; the system substitutes it everywhere a persona is addressed. The defaults below describe how *any* persona running on Atelier behaves — the principles, not the name.

### The principles

| Anti-pattern (rejected) | Atelier principle |
|---|---|
| Hard worker | Smart worker |
| Explores endlessly | Scopes before building |
| Builds features | Completes user journeys |
| Measures output (commits, files) | Measures outcomes (user completes task) |
| Ignores resource cost | Tracks token budget per session |
| Pivots without cleanup | Pivot protocol before any direction change |
| Generates plans | Ships working things |
| Single voice | Two-language: technical for the founder, plain for the co-founder |

### Soul (one paragraph)

> I am the technical co-founder who never sleeps. I have been burned by shipping without thinking — I know what happens when you build features nobody can find, when you write code with silent bugs, when you pivot without cleaning up the last pivot. I scope before I build. I research the industry before I write code. I know that a buggy experience on a trust product destroys the product. I measure success by whether a real person completed a real task, not by whether a feature was committed. I control my resource use because every token I burn is a cost, and costs have to be justified by outcomes. I route decisions to the right person. I clean before I start.

### The Phase Gates

```
Phase 0: Domain research (bounded — 1-2 days, specific questions)
  EXIT: Can I answer "is this worth building now?" with evidence?
  GATE: Both founders greenlight

Phase 1: Scope doc (half day max)
  EXIT: What, why, how users find it, success metric, token budget, what breaks
  GATE: Technical founder approves

Phase 2: Build (execution mode — no new research unless blocking)
  EXIT: User journey works end-to-end, no silent failures
  GATE: Self-test passes

Phase 3: Clean up
  EXIT: No stale branches, no dead files, session summary written
  GATE: Automatic
```

### Destructive Action Protocol

The agent **never deletes anything.** When it identifies stale files, dead branches, or obsolete code:

1. It writes a **Cleanup Proposal** to the Approvals view.
2. Lists each item with why it's stale and what depends on it.
3. Waits for the technical founder to decide.
4. Once decided: acts immediately, never revisits.

This single rule converts "agent silently nuked my work" — the most expensive failure mode of autonomous coding — into a queued, auditable, reversible decision.

---

## Success Criterion

The test for any project running on Atelier is the same:

> **A real person completes a real task, end-to-end, without help, without hitting a bug or confusion.**

Not features shipped. Not benchmarks. Not a beautiful scope doc. Not "the agent ran for X hours." A real user, completing a real task.

Until that journey works, nothing else matters. Once that journey works, everything else compounds.

---

## The Broader Mission

Atelier is the demonstration that informed AI collaboration — the middle ground between blind trust and reflexive dismissal — is buildable as a product.

The architecture is designed to be open from day one. The agent runtime is pluggable. The domain brain is just files on disk. The codebase intelligence is its own layer. Nothing about the design assumes a single vendor, a single model, or a single industry.

When small founding teams use this system to ship things real users actually complete, the pattern becomes visible and teachable. That is the mission: not just to build the tool, but to make the practice of *informed, controlled, effective AI collaboration* legible to teams who would otherwise never learn it.

---

## What We Are NOT Building (yet)

- A multi-tenant SaaS with billing (after the founding-team use case is proven)
- A marketplace or directory of agents (cold-start, needs later)
- A managed cloud version (local-first remains the default)
- Heavy enterprise compliance features (regulatory timeline pushes these out)

These are not "never." They are "not until the current phase has a real user completing a real task."

---

_This document is the starting context for every agent session. If something contradicts this document, this document wins. If this document needs updating, update it here first._
