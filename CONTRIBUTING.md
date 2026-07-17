# Contributing to Informed Vibe Atelier

Thanks for looking at this project. This file covers the three things you need before opening a PR: the mental model, how to run the app locally, and what must pass before you submit.

---

## Mental model — Canvas → Approvals → Implementer

Atelier's core loop has one load-bearing invariant: **nothing runs until a plan node is approved.**

Here is the full sequence:

1. **Vague ask** — you type something ambiguous into the Now terminal ("fix my UI", "add auth").
2. **Drafter decomposes** — the Drafter agent breaks the ask into discrete Canvas plan-nodes. Each node has an intent, a "who it helps", and acceptance criteria. No code is written yet.
3. **Approve in the Approvals view** — you review the nodes the Drafter produced. You approve the ones you want built and defer or reject the rest. Only approved nodes are queued for execution.
4. **Implementer executes** — the Implementer agent runs only the approved nodes, one at a time. It produces diffs you can review.

Why this matters for contributors: any change that causes the Implementer to act on unapproved nodes, or that causes the Drafter to skip decomposition and go straight to building, breaks the project's reason for existing. Keep this invariant in mind when touching `backend/src/agent/`, `frontend/src/views/Canvas.tsx`, or `frontend/src/views/Approvals.tsx`.

The other surfaces — Brain, Reflect, World — are experimental scaffolds off by default. They are not required for the core loop and should not be the subject of a first contribution.

---

## Dev environment

### Prerequisites

| Dependency | Minimum | Install |
|---|---|---|
| **Bun** | ≥ 1.1 | `curl -fsSL https://bun.sh/install \| bash` |
| **Node.js** | ≥ 20 | via `nvm` or system package manager |
| **ttyd** | any recent | Static binary (works on any Linux): `curl -Lo /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x /usr/local/bin/ttyd`; on Ubuntu/Debian with universe: `sudo apt install ttyd`; on macOS: `brew install ttyd` |
| **Provider CLI** | — | One of: `claude` (Anthropic), `gemini` (Google), or `qwen` (via LM Studio). Must be authenticated before starting the app. |

### Start the app

```bash
# Install dependencies (run once, or after pulling new commits)
bun install

# Start backend (:3001) + frontend (:5174) together
npm run dev

# Alternatively, use the project wrapper
./bin/informed-vibe start
```

The app opens at `http://localhost:5174`. The Now terminal requires ttyd and an authenticated provider CLI — if the terminal is blank, run `./bin/informed-vibe validate` to see which preflight check failed.

### Reset to fresh onboarding

Clear `agent_name`, `founder_name`, `org_name`, and `active_project` in `agents/config.yaml`.

---

## Quality gate

Every PR must pass two checks before it will be reviewed.

### 1. Typecheck — required, no exceptions

```bash
npm run typecheck
```

This runs `tsc --noEmit` across both `backend/` and `frontend/`. **A PR that breaks typecheck will not be merged.** Fix all errors before pushing.

### 2. `bin/check.sh` — required for runtime-touching changes

```bash
./bin/check.sh --skip-smoke   # fast: §1 secret scan + §3 typecheck + §4 PII check
./bin/check.sh                 # full: adds §5 Docker cold-clone smoke (~3 min)
```

Run `--skip-smoke` for every change. Run the full check (without `--skip-smoke`) if your change touches anything under `backend/src/agent/`, `frontend/src/views/Now.tsx`, `backend/src/boot/validate.ts`, or `bin/`.

The §5 smoke builds a clean container with no host credentials, clones the repo, boots the app, and asserts that the PTY produces a non-empty `raw.log`. "Boot checks passed on my machine" is not sufficient if you already have ttyd and a logged-in provider installed — the smoke is the canonical gate.

The check also runs a secret and PII scan (§1). Do not commit `.env` files, private keys, or personal data. The scan catches Anthropic API keys, GitHub personal access tokens, AWS access key IDs, private-key headers, and local paths like `/home/<you>/`.

---

## Touching `agents/` (system prompts)

Agent principles in `agents/principles/` and `agents/prompts/` ship as **generic, high-fidelity** — applicable to any founder, no personal narrative. If your PR edits these files:

- Run a personal-data sweep before pushing: search for your own names, project names, and local paths — must return zero hits.
- Persona name is a runtime variable (`{{agent_name}}`); don't hardcode names.
- Read the file as a stranger would. If it requires "the maintainer's specific journey" to make sense, generalize it.

---

## Submitting a PR

Branch from `main`, keep the scope narrow (one logical change per PR), and reference the issue number in the PR description. Open the PR as a draft if you want early feedback on direction before the work is complete. One maintainer review is required before merge; expect a response within 2–3 days. If you are working on a good-first-issue, comment on the issue with a brief outline before writing the full implementation — this catches misunderstandings early.

---

## License

By contributing, you agree your changes are licensed under Apache 2.0 (the project's license). No CLA.
