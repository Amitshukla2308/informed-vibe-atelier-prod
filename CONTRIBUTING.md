# Contributing to Informed Vibe Atelier

Thanks for considering a contribution. This guide covers the basics; ask in an issue if anything is unclear.

## Dev setup

```bash
git clone https://github.com/Amitshukla2308/informed-vibe-atelier-prod.git
cd informed-vibe-atelier-prod
cd backend && bun install && cd ..
cd frontend && npm install && cd ..
```

Run dev:

```bash
npm run dev    # backend (:3001) + frontend (:5174) in one terminal
```

Type-check:

```bash
npm run typecheck
```

## Workflow

1. Open an issue first for non-trivial changes — describe what + why before writing code.
2. Fork → branch → PR. Branch names: `feat/...`, `fix/...`, `docs/...`, `refactor/...`.
3. Keep PRs focused. One concern per PR.
4. Conventional commit messages preferred (`feat: ...`, `fix: ...`, `docs: ...`).
5. PRs run local checks; CI is being added.

## Touching `agents/` (system prompts)

Agent principles in `agents/principles/` and `agents/prompts/` ship as **generic, high-fidelity** — applicable to any founder, no personal narrative. If your PR adds or edits these files:

- Run a personal-data sweep — substitute your own list of names/projects/paths to scrub: `grep -rIn "Maintainer-Name\|Internal-Project-Name\|/home/your-username" agents/` — must return zero hits.
- Read the file as a stranger would. If it requires "the maintainer's specific journey" to make sense, generalize it.
- Persona name is a runtime variable (`{{agent_name}}`); don't hardcode names.

## What we look for

- Tests where a test makes sense (the project does not yet have a test harness — adding one is welcome).
- Type-clean changes (`npm run typecheck` passes).
- No new lockfiles in unexpected places (we use `bun install` in backend, `npm install` in frontend).
- No bundled secrets, no real user data in fixtures.

## Code of Conduct

Read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). It's enforced.

## License

By contributing, you agree your changes are licensed under Apache 2.0 (the project's license). No CLA.
