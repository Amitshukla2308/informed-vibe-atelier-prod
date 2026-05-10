# Atelier Guardians — scaffold

Per-project pattern rules that flag when an action would violate a project invariant. Loaded by Implementer (pre/post-execution) and Drafter (plan-time sanity).

**Spec:** `agents/principles/guardians.md`
**Per-project rules:** `atelier/projects/<P>/guardians.yaml`
**Brain precedence:** Guardians > brain on conflict — see C2 section in principle.

## What's shipped (scaffold)

- `load.ts` — YAML loader for `projects/<P>/guardians.yaml`. Returns parsed rules + applicable subset for current stage.
- `preExecutionScan(intent, rules, ctx)` / `postExecutionScan(diff, rules, ctx)` — return-no-violations stubs so callers can wire integration.
- Example rules at `projects/<slug>/guardians.yaml` (e.g. secrets / DB safety / regulator citation / float money / PDF fallback / test coverage / plain-English copy).

## What's NOT yet shipped (initiative-scoped)

- **Pattern engine.** Regex matching, scope globbing, severity routing, exclude_if predicate evaluation. The stubs return zero violations until this lands.
- **Drafter integration.** Drafter should sanity-check proposed plans against the rules at draft time. No hook yet.
- **Implementer integration.** Implementer should call preExecutionScan before each tool action and postExecutionScan on the diff. No hook yet.
- **Canvas badge surface.** Yellow (warn) / red (block) badges on the node when violations land. No frontend yet.
- **Kanban override flow.** When `block` fires, founder needs an "approve override (one-time)" / "amend Guardian" / "fix and re-run" UI. No surface yet.
- **Drafter rule-proposal.** Drafter examines the project domain and proposes starter rules; founder confirms/edits.

## Next steps when this becomes the initiative

1. Implement pattern engine in `engine.ts` — start with regex over file content + glob over scope.
2. Wire `preExecutionScan` into Implementer's tool-call hook (probably in `mcp/server.ts` or wherever tool calls are intercepted).
3. Wire `postExecutionScan` into the post-action diff capture.
4. Surface violations through WS events (`guardian.violation` payload) for the frontend.
5. Build the Kanban override row.
6. Drafter rule-proposal flow — separate Drafter prompt addendum + founder approval queue entry.

## Why this is separate from a code-intelligence Ripple-Guard

A typical Ripple-Guard is a **CI-time** code-review tool: runs against shipped repos via GitHub Action, scores PRs for blast radius and security gaps.

Atelier Guardians are **session-time** invariants: run inside the agent's loop as it generates code, before/after each Implementer action. Same conceptual shape (YAML rules with patterns + severity), different runtime (session vs CI) and different audience (founder editing rules during the build, not reviewer-after-the-fact).

Mirror the SCHEMA where useful (severity levels, pattern format, scope globs), build the engine fresh.
