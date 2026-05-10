# Install Informed Vibe Atelier

v0 supports Linux, Mac, and Windows-via-WSL. Native Windows is on the roadmap.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Bun | ≥1.1.0 | Backend runtime |
| Node | ≥20 | Frontend tooling (Vite) |
| ttyd | ≥1.7 | Browser PTY for the CLI subprocess |
| One CLI agent | latest | One of: `claude` / `gemini` / `qwen-code` / `opencode` |
| Python | ≥3.10 | OmniGraph (vendored brain pipeline) — optional but recommended |

## Linux

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# Node (via nvm — adjust to your taste)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20

# ttyd
sudo apt install ttyd      # Debian/Ubuntu
# or build from source: https://github.com/tsl0922/ttyd

# CLI agent (Claude shown; substitute your preferred provider)
npm install -g @anthropic-ai/claude-code
claude login

# Python (for the vendored OmniGraph brain pipeline — optional)
sudo apt install python3 python3-pip
```

## Mac

```bash
brew install bun node ttyd python
npm install -g @anthropic-ai/claude-code
claude login
```

## Windows (via WSL)

Native Windows is on the roadmap; today, run inside WSL2. Open a WSL2 Ubuntu shell and follow the Linux steps.

## Install Atelier

```bash
git clone https://github.com/Amitshukla2308/informed-vibe-atelier-prod.git
cd informed-vibe-atelier-prod
./bin/informed-vibe init
```

`init` installs backend deps (`bun install`), frontend deps (`npm install`), creates a fresh SQLite DB, picks free ports, and writes a default `agents/config.yaml`.

## Run

```bash
./bin/informed-vibe start
```

Backend on `:3001`, frontend on `:5174`. Open http://localhost:5174.

## First-run flow

1. Land on the welcome screen.
2. Name your AI co-founder. This is permanent — it's how the agent will refer to itself going forward.
3. Pick your provider (Claude / Gemini / Qwen-Code / OpenCode).
4. Verify your provider CLI is logged in (`claude login`, `gemini auth login`, etc.).
5. Drop into the Now view — your first session.

## Stop

```bash
./bin/informed-vibe stop
```

## Optional: enable the brain (OmniGraph)

Atelier ships with a vendored OmniGraph at `omnigraph/` that compiles a 3-layer brain (global / personal / project) from your past AI-tool conversations. Without it, the agent runs without founder context.

```bash
./bin/informed-vibe brain init       # installs deps + sets up output dir
./bin/informed-vibe brain compile    # one-shot run
./bin/informed-vibe brain daemon     # optional: refresh every 10 min in background
```

See [`omnigraph/README.md`](./omnigraph/README.md) for what's vendored and [`docs/BRAIN_INTEGRATION.md`](./docs/BRAIN_INTEGRATION.md) for the file-drop contract.

## Multi-user

See [docs/MULTI_USER.md](./docs/MULTI_USER.md) for exposing the install to remote co-founders via Cloudflare tunnel.

## Troubleshooting

- **Port in use:** `./bin/informed-vibe stop` then check `lsof -i :3001 -i :5174` for stragglers.
- **Provider CLI not found:** ensure `claude` (or your provider's binary) is on `$PATH`. Override via env: `CLAUDE_BIN=/path/to/claude ./bin/informed-vibe start`.
- **ttyd not found on Mac:** `brew install ttyd`.
- **Bun on Windows-native fails:** use WSL2 instead. Native Windows is roadmap.
