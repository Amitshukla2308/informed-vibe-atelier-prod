# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** before disclosing publicly.

**Preferred:** GitHub Security Advisory — https://github.com/Amitshukla2308/informed-vibe-atelier-prod/security/advisories/new

**Alternative:** email amitshukla2308+security@gmail.com with the subject `[security] <short title>`.

We aim to acknowledge within 72 hours and provide a remediation timeline within 7 days.

## Scope

In scope:

- The Atelier backend (auth, MCP host, session handling, multi-tenant routing).
- The Atelier frontend (XSS, CSRF, sensitive data handling).
- The `bin/informed-vibe` CLI.

Out of scope (file with the upstream project):

- Provider CLI subprocess vulnerabilities (Claude / Gemini / Qwen-Code / OpenCode).
- ttyd vulnerabilities (https://github.com/tsl0922/ttyd).
- Bun, Node, npm, or Vite vulnerabilities.

## Auth model

Multi-tenant auth is the **γ design** — invite tokens + httpOnly cookies + SQLite-backed sessions. No CF Access, no SMTP. Detailed model: [docs/AUTH_MODEL.md](./docs/AUTH_MODEL.md).
