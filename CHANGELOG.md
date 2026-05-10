# Changelog

All notable changes to Informed Vibe Atelier are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [SemVer](https://semver.org/) (or rather, "v0 SemVer" — pre-1.0, breaking changes can land in any v0.x bump).

## [Unreleased]

## [v0.0.5] — 2026-05-10

### Added
- Standalone OmniGraph repo (`github.com/Amitshukla2308/omnigraph`) rebuilt with clean history (force-rewrite via `git filter-repo`) and packaged for PyPI (`informed-vibe-omnigraph`). Companion to the vendored copy; restores Cursor / Continue / Cline interop per the Apr-30 / May-2 distribution plans. Flip-to-public + PyPI upload gated on maintainer review.
- `_meta.json` provenance stamp on vendored brain output (`omnigraph_version: 2026-05-10-v0.0.1-trim`, `schema_version: 0.2.1`, `trim_notes`). The public artifact now accurately reports the trimmed runtime instead of inheriting the upstream `v0.4.1` string.

### Changed
- `bin/informed-vibe brain` (and the underlying `omnigraph_cli.py`): `index` and `query` subcommands now graceful-error with a message pointing users at the standalone package. Previously crashed on lazy-import of the dropped `src/hr/` module.
- MCP brain-tool runner: `findOmnigraphRunner` now also probes the vendored copy under `config.atelierRoot/omnigraph/src/omnigraph_cli.py`. Resolution order: PATH-resolved `omnigraph` → vendored copy → canonical informed-vibes layout → legacy `~/projects/omnigraph/` path.

### Roadmap decisions
- **Distribution shape (hybrid).** The v0.0.4 vendoring of OmniGraph at `omnigraph/` stays as the install-friendly default for first-run founders. The separate standalone OmniGraph package (now built; flip-to-public gated) restores the substrate-vs-UX boundary captured in the Apr-30 / May-2 distribution plans and enables interop with Cursor / Continue / Cline / other readers against the same `og_artifacts/` contract. Both shapes coexist intentionally — vendored gets you running fast; standalone gets you interop. This decision re-ratifies the post-leak-containment vendoring as a deliberate choice rather than an accident.
- **Power C (Brain visualization) retired from the roadmap.** The original Apr-25 OmniGraph ROADMAP listed three powers — A: boot-prompt injection, B: Domain Brain drafts, C: Brain visualization (Personal Brain view, React Three Fiber, relationship-graph-backed query). Powers A and B are shipped (B partially — writer side vendored, the Approvals/viability-verdict reader UX is still Phase B work in PLAN.md). **Power C was implicitly dropped during the v0.0.4 trim** (`src/viz` + `src/hr` removed from the vendored OmniGraph). This release retires Power C from the public roadmap so docs match reality. Brain visualization can resurface as a separate project against the `og_artifacts/` contract if value materializes; it is not coming back as part of v0.x of Informed Vibe Atelier.

### Security
- **Git history scrub.** A LAN IP (`192.168.88.2:1234`, an LM Studio default the maintainer's machine had hardcoded into the OmniGraph Qwen-Code adapter) was removed from all of `informed-vibe-atelier-prod`'s git history via `git filter-repo --replace-text`. Working tree, all commits, and all release tags now contain the generic `localhost:1234` placeholder. v0.0.1 / v0.0.2 / v0.0.3 commit SHAs unchanged; v0.0.4 commit SHA rewritten from `2f8b1a7` → `87715d7`. Anyone who cloned during the brief window the IP was public will need to re-clone.

## [v0.0.3] — 2026-05-10

### Added
- Onboarding wizard now exposes all 4 providers (Claude / Gemini / Qwen-Code / OpenCode). Backend adapters were already in place; UI now matches.
- `bin/informed-vibe status` command (was already implemented; documented in README).
- `CHANGELOG.md` (this file).
- GitHub Actions CI workflow — runs `npm run typecheck` on push + PR.

### Changed
- README "Surfaces" table rewritten to match actual nav rail (10 surfaces, not 9).
- README install instructions: `provider add` semantics now match the actual CLI behavior (point users at Settings → Providers in the UI rather than the not-yet-implemented OAuth-flow-on-CLI).
- INSTALL.md: `claude /login` → `claude login` (typo).
- Repo `homepageUrl` corrected (was pointing at the old `informed-vibe` repo).

### Fixed
- (No code fixes in this release; all v0.0.2 functionality preserved.)

## [v0.0.2] — 2026-05-10

### Fixed
- **First-run cold-clone now actually works end-to-end.** Three install-blocking bugs from v0.0.1:
  - SignIn page defaulted to "Sign in" tab on a zero-user DB. Now detects first-run via `GET /auth/install-state` and renders "Set up your install." with the register form directly.
  - After bootstrap-register, redirected to `/home` which fell through to landing. Now redirects to `/?signin=admin` so onboarding wizard renders.
  - `/onboarding/complete` only updated `agents/config.yaml` and never wrote to SQL. Multi-tenant ACL then 403'd canvas/sessions/brain. Now mirrors output to `orgs` + `memberships` + `projects` rows (`default_visibility='all'`, role `admin`, idempotent INSERT OR IGNORE).

### Added
- `GET /auth/install-state` (public; reports `host_exists` + `user_count`).
- `.gitignore`: `.run/` (CLI pid files + logs).

## [v0.0.1] — 2026-05-10

Initial public release. ⚠️ **Bootstrap host couldn't actually use the workspace** — the v0.0.2 fixes are required for any practical use. Tagged for history; do not deploy v0.0.1.

### Added
- Bun/TS backend with HTTP, WebSocket hub, MCP server.
- React frontend (Now / Canvas / Brain / Approvals / Reflection / Settings / Onboarding).
- Multi-tenant auth (γ model: invite tokens + httpOnly cookies + SQLite).
- ttyd terminal path (Linux native, Mac native, Windows-via-WSL).
- Brain reader (works without OmniGraph; auto-loads if present).
- `bin/informed-vibe` CLI.
- Apache 2.0 license, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.

[Unreleased]: https://github.com/Amitshukla2308/informed-vibe-atelier-prod/compare/v0.0.5...HEAD
[v0.0.5]: https://github.com/Amitshukla2308/informed-vibe-atelier-prod/releases/tag/v0.0.5
[v0.0.3]: https://github.com/Amitshukla2308/informed-vibe-atelier-prod/releases/tag/v0.0.3
[v0.0.2]: https://github.com/Amitshukla2308/informed-vibe-atelier-prod/releases/tag/v0.0.2
[v0.0.1]: https://github.com/Amitshukla2308/informed-vibe-atelier-prod/releases/tag/v0.0.1
