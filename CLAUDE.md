> ⚠ THIS IS THE PUBLIC OSS REPO.
> All commits push to github.com/Amitshukla2308/informed-vibe-atelier-prod (PUBLIC).
> NEVER add personal data, customer data, real founder names, project names, .env content, or DB files here.
> The .gitignore is the second line of defense, not the first.
> Private overlay (where personal artifacts go) lives at ../atelier/.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## What this project is

Informed Vibe Atelier — a local-first workspace for AI co-founders. Backend is a Bun/TS MCP host with a PTY bridge to a CLI agent subprocess; frontend is a React control panel.

## Run / dev

```bash
npm run dev          # backend :3001 + frontend :5174 (or use ./bin/informed-vibe start)
npm run typecheck    # tsc --noEmit across backend + frontend
npm run lint         # frontend eslint
```

There is no test suite yet. Adding one is welcome.

Reset to fresh onboarding: clear `agent_name / founder_name / org_name / active_project` in `agents/config.yaml`.

## Architecture (the parts that span files)

```
Frontend (React 19 + Vite, :5174)
    │  HTTP + WebSocket
Backend (Bun + TS, :3001)
    ├── routes/        HTTP API
    ├── ws/            WebSocket hub
    ├── mcp/           MCP server exposing canvas/brain/session tools
    ├── agent/         PTY bridge (ttyd v0; Rust sidecar v0.1) to CLI subprocess
    ├── session/       session index, reflect worker, brain loader
    ├── auth/          access tokens, middleware, invite flow (γ)
    ├── db/            SQLite
    └── project/       canvas graph CRUD, project scaffolder
```

Atelier is the control plane; the CLI is the execution plane. Multi-provider is structural — new providers slot in as a `CliAdapter`. Provider binaries are overridable via `CLAUDE_BIN` / `GEMINI_BIN` / `QWEN_BIN`.

## Data model on disk

Local-first. No telemetry.

- `agents/config.yaml` — single-founder identity + provider preference (templating: `{{agent_name}}`, `{{founder_name}}` resolve at session compose-time)
- `agents/principles/`, `agents/prompts/`, `agents/soul.md` — agent's voice and behavior
- `data/sessions/<session-id>/events.jsonl` — raw PTY event log (gitignored)
- `data/users/<uid>/` — per-user creds dir (gitignored)
- SQLite DB at `data/atelier.db` (gitignored) — auth, identity, indexes

## Conventions

- Discuss before code on non-trivial changes (open an issue).
- Type-clean changes — `npm run typecheck` must pass.
- Agent files (`agents/`) are generic by policy. See CONTRIBUTING.md for the personal-data sweep before PRs that touch them.
- Frozen seam: pty-bridge.ts / pty-helper.cjs were dropped when ttyd became the default. Don't reintroduce them; the v0.1 sidecar replaces ttyd.

## When in doubt

- `VISION.md` for what + why
- `INSTALL.md` for cold-install path
- `docs/ARCHITECTURE.md` for contributor architecture
- `docs/AUTH_MODEL.md` for the multi-tenant auth design
- `docs/MULTI_USER.md` for exposing to remote co-founders
- `docs/BRAIN_INTEGRATION.md` for OmniGraph plug-in
