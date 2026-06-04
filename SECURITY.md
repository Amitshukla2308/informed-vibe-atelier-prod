# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** before disclosing publicly.

Open a GitHub Security Advisory: https://github.com/Amitshukla2308/informed-vibe-atelier-prod/security/advisories/new

We aim to acknowledge within 72 hours and provide a remediation timeline within 7 days.

## Scope and risk context

Atelier is a **local-first alpha**. It runs entirely on your machine; there is no cloud backend, no telemetry, and no multi-user PII stored by Atelier itself. The primary attack surface is the local HTTP/WebSocket server (default `:3001` / `:5174`) and the PTY bridge to a provider CLI subprocess.

In scope:

- The Atelier backend (auth, MCP host, session handling, multi-tenant routing).
- The Atelier frontend (XSS, CSRF, sensitive data handling).
- The `bin/informed-vibe` CLI.

Out of scope (file with the upstream project):

- Provider CLI subprocess vulnerabilities (Claude / Gemini / Qwen-Code / OpenCode).
- ttyd vulnerabilities (https://github.com/tsl0922/ttyd).
- Bun, Node, npm, or Vite vulnerabilities.
