# Classification — 5D Framework

_Shared support file. Loaded by Drafter (before proposing Canvas additions) and Implementer (before executing nodes post-MVP)._

---

## What this is

Every Canvas addition (Drafter) and every execution action (Implementer, post-MVP) passes through classification on five dimensions. The classification determines autonomy level: auto-execute, propose with rationale, or hard approval gate.

## Five dimensions

| Dimension | Scale | What it checks |
|---|---|---|
| **Breaking risk** | safe / caution / breaking | Does this change contracts, APIs, data shapes, or user-facing behavior? |
| **Blast radius** | low / medium / high | How many other nodes/modules depend on what's changing? (Canvas graph answers this) |
| **Domain sensitivity** | none / soft / hard | Requires domain judgment? (legal / payments / healthcare / regulatory = hard) |
| **Vision alignment** | high / medium / low | Clearly follows stated vision + scope, or requires interpretation? |
| **Novelty** | routine / incremental / novel | Seen-this-pattern-before vs introducing something new? |

## Decision rule

```
classify(action) → (breaking, blast, domain, alignment, novelty)

if ANY dimension is HIGH-risk or LOW-confidence:
    → hard approval gate. Block. Surface on Kanban with rationale.

if ALL dimensions are low-risk/high-confidence AND alignment HIGH:
    → autonomous. Execute. Log visibly on Kanban with "auto" badge.

otherwise (middle ground):
    → propose with rationale. Blocks until founder approves (Phase A).
      Soft-timers in Phase B once trust is established.
```

## Stage modulation

- **Pre-MVP / MVP build:** classifier is **OFF**. Full autonomy. Only the one-time MVP Plan gate.
- **Post-MVP:** classifier is **ON**. All actions classify. Autonomy follows decision rule above.
- **Experimental-sandbox stage:** classifier runs but with permissive thresholds; founder can configure override zones.

## Parent approval cascade

When a parent node's plan is approved, child nodes under it auto-approve **only when each child satisfies two conditions**:
1. Child's change is **safe** (breaking = safe or caution, not breaking)
2. Child's change **does not break parent's plan/acceptance criteria**

Agent evaluates each child individually. Children that fail either check re-classify and surface for approval even under an approved parent.

## Classification visibility

- Classification shows on the Canvas card (each dimension labeled, full reasoning expandable)
- "Auto" badge is purple; "proposed" badge is grey; blocked-by-classification is red
- Founder can override any classification; overrides feed personal brain as calibration signal

## Personal brain calibration

- Founder overrides a classification → recorded in `brain/personal/<founder>/autonomy_calibration.md`
- Each override adjusts next similar classification
- After ~20-30 classification-override pairs, the classifier learns founder-specific thresholds (e.g., "this founder wants to see all framework-decisions even if routine")
- View and edit calibration in Settings → Personal Brain

## Examples

**"Add a Test node under already-approved Auth module, covering happy path"**
`safe / low / none / high / routine` → **auto-add**, purple badge

**"Add a new Theme for State Management, propose Zustand over Redux"**
`caution / high / none / medium / novel` → **proposed**, grey badge, approval required

**"Add a node for a regulatory-clause audit in a domain-sensitive project"**
`safe / low / hard / high / incremental` → **proposed** (domain-sensitive requires founder/co-founder greenlight)

**"Fix typo in approved Login component"** (Implementer post-MVP)
`safe / low / none / high / routine` → **execute**, log

**"Plan says use JWT but doesn't specify signing algorithm"** (Implementer post-MVP)
`caution / medium / soft / medium / novel` → **pause**, comment on node, wait

**"Implementer encounters fix requiring breaking API contract Y"**
`breaking / high / none / medium / novel` → **hard approval gate**. Block. Comment with options.

## Integration with Guardians

Classification is about **should this need approval?** Guardians are about **is this about to violate a project invariant?** Both can block. Classification blocks to ask for approval; Guardian blocks to ask for fix.

Both layers run pre-execution for Implementer; Drafter runs classification only (Drafter doesn't execute, so Guardians don't apply to it directly — but Drafter references project Guardians when drafting plans).

---

_Classification.md is a shared support file. Loaded by both Drafter and Implementer. Same rules; different invocation points._
