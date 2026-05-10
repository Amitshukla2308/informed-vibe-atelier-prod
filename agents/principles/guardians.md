# Guardians — Project-Invariant Protection

_Shared support file. Loaded primarily by Implementer (pre- and post-execution scans). Drafter references project Guardians when drafting plans to ensure proposed work won't violate them._

---

## What Guardians are

Per-project **pattern rules** that flag when an action would violate a project invariant. They are a Rules Engine: YAML-configurable patterns and thresholds per team, evaluated mechanically before and after execution. Think payment-safety patterns for AI-generated code, generalized to any domain the founder declares.

Guardians sit **between classification-approval and execution**:

```
classification → approval gate if required → Guardian pre-scan → execute → Guardian post-scan → done
```

## File location

`projects/<project>/guardians.yaml`

## Format

```yaml
guardians:
  - name: no_float_for_money
    pattern: "float|Decimal.*money|price"
    severity: block
    domain: payments
    rationale: "Float arithmetic is lossy. Use Decimal/BigDecimal for money."

  - name: all_endpoints_require_auth
    scope: "backend/api/**"
    check: "must_include:@require_auth OR @public"
    severity: block
    rationale: "Every API endpoint authenticates or explicitly declares public."

  - name: tests_exist_for_changed_code
    check: "diff-adjacent test file exists or added"
    severity: block-in-mvp  # only blocks post-MVP; warns pre-MVP
    rationale: "Post-MVP, shipped code has tests. Pre-MVP, we relax."

  - name: no_secrets_in_config
    pattern: "api_key|secret|password|token"
    exclude_if: "value.startswith('${') or value.startswith('process.env')"
    severity: block
    rationale: "Secrets never in source. Always env-var reference."
```

### Severity levels

- `block` — Implementer stops, surfaces to Kanban with rationale, does not ship until resolved
- `block-in-mvp` — block post-MVP; warn pre-MVP (logs the violation but doesn't stop)
- `warn` — log violation; ship proceeds; founder can review later
- `audit-only` — record but don't change behavior (for testing new rules)

## How Guardians get defined

1. **Drafter proposes** based on project's domain and scope. "This is fintech — I'd propose these 5 invariants: [list]. Approve?"
2. **Founder confirms, edits, or adds.** Founder-authored Guardians are first-class.
3. **Guardians evolve.** When something slips through that should have been caught, {{founder_name}} (or the agent on reflection) proposes a new Guardian. Growth is a feature.

## When Guardians run

- **Pre-execution (Implementer):** scan intended approach against Guardians before writing code. Block if `block`-severity violation detected.
- **Post-execution (Implementer):** re-scan diff before marking node done. Block if any violation introduced.
- **Drafter reference:** when Drafter proposes a node's plan, it sanity-checks the plan against existing Guardians and flags likely violations in the plan itself. Prevents plans that would necessarily violate Guardians at execution time.

## Stage behavior

- **Pre-MVP / MVP build:** Guardian layer is **OFF**, except:
  - `severity: block` rules marked `always_on: true` still apply (e.g., `no_secrets_in_config`, destructive-action patterns)
  - Everything else is disabled; the MVP sprint doesn't pay for Guardian overhead
- **Post-MVP:** full Guardian layer active.

## Violations go to review queue

When a Guardian blocks, the violation details land on the node's discussion:
- Which Guardian fired
- Matched pattern/location
- Rationale from the Guardian definition
- Suggested remediations (agent proposes fix)
- Founder can: approve override (one-time), amend Guardian (ongoing), or fix and re-run

## Guardian → Canvas color coding

- Clean pre-scan → proceed
- Warn-level violation → yellow badge on node; proceed
- Block-level violation → red badge; halt; await resolution

## Shared Implementer + Drafter

- **Implementer**: enforces Guardians (pre- and post-execution)
- **Drafter**: reads Guardians when drafting plans; flags in the plan if the planned work would necessarily violate a Guardian ("Plan proposes float-based price calculation but `no_float_for_money` Guardian would block this — here's an alternative using Decimal")

Both modes load `guardians.yaml` in context. Drafter uses it read-only as a plan constraint; Implementer uses it as an enforcement layer.

## Starter Guardian sets by domain

Drafter proposes these at project scope time based on declared domain:

**Any project:**
- `no_secrets_in_config` (always-on, every stage)
- `no_destructive_migrations_without_backup` (post-MVP)
- `tests_exist_for_changed_code` (post-MVP)

**Fintech / payments:**
- `no_float_for_money`
- `idempotency_key_on_mutations`
- `retries_are_bounded`
- `audit_log_on_state_changes`

**Regulated domains (HIPAA, GDPR, financial regulators, etc.):**
- `regulatory_fields_validated`
- `pii_encrypted_at_rest`
- `audit_trail_on_access`

**APIs:**
- `all_endpoints_require_auth`
- `rate_limits_on_public_endpoints`
- `input_validation_on_external_data`

Starter sets are proposals, not impositions. Founder edits freely.

---

_Guardians are project invariants enforced mechanically. Loaded by Implementer for enforcement; by Drafter for plan-time sanity. Evolution is a feature — every miss that should have been caught becomes a new Guardian._

---

## Guardians vs the brain layer — precedence

The brain layer (loaded into every session's system prompt — global + personal + project) provides **soft preferences**: founder mental moves, AI-collaboration habits, project entity context. Guardians provide **hard rails**: pattern rules whose violation BLOCKS execution.

**Where they meet:** when brain says one thing and a Guardian says another, **Guardians win.** Rules:

1. A `block`-severity Guardian violation always halts execution, regardless of what the brain block says about founder preferences.
2. A `warn`-severity Guardian violation logs and proceeds; the brain's anticipation hints may suggest mitigations but do not override Guardian severity.
3. Brain mental moves like "ship before polish" inform *when* to run a check (e.g., during pre-MVP, relax test-coverage Guardian), not *whether* to honor it.
4. Founder-authored Guardians outrank machine-proposed ones; brain-mined recurring concerns can become PROPOSED Guardians via Drafter, but founder must promote them before they enforce.

**Source separation:** brain is per-founder + per-project (the brain compiler publishes); Guardians are per-project (`projects/<P>/guardians.yaml`, founder-curated). They flow in parallel through the agent's system prompt; Guardians via `principles/guardians.md` + the rules file, brain via the compiled brain markdown.
