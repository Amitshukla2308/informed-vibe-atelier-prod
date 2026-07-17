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
│   ├── terminal-server.ts  ttyd bridge — spawns ttyd; PTY child is ttyd's, not Bun's
│   ├── terminal-proxy.ts   WebSocket relay between frontend and ttyd
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

## Agent topology

The load-bearing loop uses **two roles**:

| Role | File | Function |
|---|---|---|
| **Drafter** | `agent/drafter-background.ts` | Decomposes a vague ask into approvable Canvas nodes (intent + acceptance criteria). Nothing executes until the founder greenlights a node. |
| **Implementer** | (provider CLI subprocess) | Executes one approved node via a single provider (claude / gemini / qwen-code / opencode). |

`agent/fixer.ts` and `agent/researcher.ts` exist as auxiliary helpers but are not in the primary demo path. Allocator and Senior Reviewer are deferred to a future milestone.

## Auth (γ)

- Invite tokens are 32-byte random values, single-use, 7-day TTL, stored in SQLite.
- A redeemed invite creates a user row + a `data/users/<uid>/` directory for that user's provider creds.
- Sessions are httpOnly cookies bound to the user row. SQLite tracks active sessions; revocation is immediate.
- No CF Access, no SMTP. The invite link is the sole onboarding channel.

Detailed: [AUTH_MODEL.md](./AUTH_MODEL.md).

## Brain reader

`backend/src/session/load-omnigraph-brain.ts` reads `~/.informedvibe/og_artifacts/` at session boot, caches per-session, and inlines content into the system prompt. Missing files degrade gracefully. See [BRAIN_INTEGRATION.md](./BRAIN_INTEGRATION.md).

## Removed components

These were removed; do not reintroduce them:

- **`pty-bridge.ts` / `pty-helper.cjs`** — dropped when ttyd became the default terminal backend. The live bridge is `agent/terminal-server.ts`. A future v0.1 Rust sidecar will eventually replace ttyd.
- **`node-pty`** — removed from `backend/package.json`. Bun+node-pty triggers SIGHUP on PTY children at ~12 ms; unfixable under Bun. The ttyd path avoids this: ttyd calls `forkpty()` itself, making the CLI process its child rather than Bun's.
- **`:3011` sidecar as default** — `Now.tsx` formerly defaulted `terminalEngine` to `"sidecar"` pointing at `ws://localhost:3011/ws`. No sidecar ships in this repo. The default is now `"ttyd"`; the `VITE_ATELIERAPP_WS_URL` env-var toggle is reserved for future use.
