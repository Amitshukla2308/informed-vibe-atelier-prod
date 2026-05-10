# Architecture (for contributors)

This doc orients new contributors. Cross-reference: [PROJECT_SHAPE.md](./PROJECT_SHAPE.md), [AUTH_MODEL.md](./AUTH_MODEL.md), [FRONTEND_TERMINAL_SURFACE.md](./FRONTEND_TERMINAL_SURFACE.md).

## The 30-second mental model

```
        Browser
            |
            v
[ Frontend :5174  React + Vite ]
            |
            | HTTP + WebSocket
            v
[ Backend :3001  Bun + TS ]
            |
            | spawn + PTY (ttyd in v0)
            v
[ CLI subprocess  claude | gemini | qwen-code | opencode ]
            |
            | --mcp-config
            v
[ Atelier MCP server ]  <-- back to backend; tools: canvas, brain, session
```

The CLI subprocess thinks it's just running with an MCP config. Atelier sets that config to point back at itself. Result: the agent can read/write canvas nodes, brain entries, and session state via tool calls.

## Backend layout

```
backend/src/
├── index.ts              entrypoint — boot HTTP + WS + MCP
├── routes/               HTTP endpoints (JSON over fetch)
├── ws/                   WebSocket hub (frontend ↔ session events)
├── mcp/                  MCP server: canvas / brain / session tools
├── agent/                CLI subprocess management + provider adapters
│   ├── providers/        one CliAdapter per provider
│   └── ...
├── session/              session lifecycle, reflect worker, brain loader
├── auth/                 invite tokens, cookies, middleware
├── db/                   SQLite schema + migrations
├── project/              canvas graph CRUD, project scaffolder
└── boot/                 validate.ts — preflight checks
```

## Frontend layout

```
frontend/src/
├── views/
│   ├── Landing/          marketing-ish
│   ├── SignIn/           invite-token redemption
│   ├── Onboarding/       agent_name + founder_name + provider pick
│   ├── Home/             post-onboarding lobby
│   ├── Now/              the active session — terminal + canvas + brain rail
│   ├── Canvas/           full-screen canvas editor (xyflow + dagre)
│   ├── Reflection/       end-of-session 6-lens reflection
│   └── Settings/         providers, invites, identity
├── styles/
│   ├── design.css        design tokens
│   ├── atelier-components.css
│   └── omnigraph.css
└── ...
```

## Multi-provider

Provider abstraction is `backend/src/agent/providers/<provider>.ts`. Each adapter exports:

- `bin: () => string` — resolve binary path, honoring `<PROVIDER>_BIN` env var.
- `composeArgs: (mcpConfigPath, sessionPrompt) => string[]` — build CLI args.
- `parsePtyEvent: (chunk) => Event | null` — extract structured events from PTY output.

Add a new provider: write a new adapter, register it in `providers/index.ts`, add it to the onboarding picker.

## Auth (γ)

- Invite tokens are 32-byte random values, single-use, 7-day TTL, stored in SQLite.
- A redeemed invite creates a user row + a `data/users/<uid>/` directory for that user's provider creds.
- Sessions are httpOnly cookies bound to the user row. SQLite tracks active sessions; revocation is immediate.
- No CF Access, no SMTP. The invite link is the sole onboarding channel.

Detailed: [AUTH_MODEL.md](./AUTH_MODEL.md).

## Brain reader

`backend/src/session/load-omnigraph-brain.ts` reads `~/.informedvibe/og_artifacts/` at session boot, caches per-session, and inlines content into the system prompt. Missing files degrade gracefully. See [BRAIN_INTEGRATION.md](./BRAIN_INTEGRATION.md).
