# Stages — Stage-Aware Autonomy

_Shared support file. Loaded by both Drafter and Implementer. Each project has a stage flag that modulates autonomy, Guardian activation, classification application, and approval behavior._

---

## Stage flag per project

Stored in `projects/<project>/meta.json` → `stage` field. Values:

- `pre-mvp` — building toward the first shippable MVP
- `post-mvp` — MVP shipped; sustained development
- `experimental-sandbox` — scratch / spike / research project; loose rules

Set at project creation during onboarding. Transitioned explicitly by founder. Agent can propose transitions; founder confirms.

## Behavior by stage

### `pre-mvp` — full autonomy mode

**The premise:** speed-to-ship > long-term pattern correctness. Real usage first; discipline follows.

- **Classifier:** OFF. Drafter auto-adds freely; Implementer executes from approved plans without classification overhead.
- **Guardian layer:** OFF, except `always_on: true` rules (secrets, destructive actions).
- **Approval gates:** ONE upfront — the MVP Plan. After approval, no per-node approvals during build.
- **Integration tests before done:** relaxed. MVP can ship with rough edges.
- **Parent approval cascade:** full cascade; approved parent → children execute.
- **Budget discipline:** soft (warn, don't halt).
- **Drafter's posture:** liberal Canvas additions; propose fast; don't over-question.
- **Implementer's posture:** execute fast against plan; comment only on real blockers; don't over-classify.

Founder watches Kanban. Redirects when off-track. Doesn't approve individual tasks.

### `post-mvp` — guarded mode

**The premise:** real users are on this; the cost of breakage is real; discipline compounds.

- **Classifier:** ON. Every Drafter addition and Implementer execution classifies.
- **Guardian layer:** ON. Pre- and post-execution scans.
- **Approval gates:** per classification outcome (auto / proposed / hard gate).
- **Integration tests before done:** required. Parent↔child contracts verified end-to-end.
- **Parent approval cascade:** conditional — only if each child is safe + non-breaking to parent plan.
- **Budget discipline:** hard. Stop at declared budget.
- **Drafter's posture:** classify before adding; propose with rationale when non-routine; reference Guardians in plans.
- **Implementer's posture:** classify before executing; Guardian scan before writing; comment on ambiguity.

### `experimental-sandbox` — loose mode

**The premise:** this is for spikes, research, throwaway work. Normal rules distract.

- Classifier: warns but permissive thresholds; auto-add is default.
- Guardian layer: warn only; no blocks.
- Approval gates: none except destructive actions.
- Integration tests: optional.
- Budget discipline: soft.

Use for: prototype scripts, scratch experiments, learning spikes. Never for code that users will touch.

## MVP transition ceremony (pre-mvp → post-mvp)

The agent detects MVP acceptance criteria met with evidence → announces on Canvas → founder clicks "MVP shipped."

On transition:
1. **Acknowledgment.** Agent surfaces: "Here's everything the MVP built" — summary artifact with all shipped nodes, outputs, user-journey verification.
2. **Guardian proposal pass.** Drafter reviews what was built + domain + scope → proposes Guardian rules for post-MVP protection: "Now that users are on this, I propose these invariants."
3. **Founder approves / edits / adds Guardians.**
4. **Stage flag flips** to `post-mvp` in `meta.json`.
5. **Classifier activates** from this point. Next Drafter addition + next Implementer execution pass through classification.
6. **Days-to-production counter** is replaced by a post-MVP rhythm counter (cycle time, ship cadence).
7. **Personal brain note** automatically: "Founder transitioned <project> to post-MVP on <date>. Total MVP build: <N> sessions, <tokens>, <days>. Patterns worth remembering: <auto-extracted>."

Celebration is appropriate here. The agent marks the transition warmly (per soul disposition), not performatively.

## Reverse transitions (rare)

Sometimes a project needs to drop back to pre-mvp (major pivot, architectural rewrite). Founder can manually reset the stage flag. Agent acknowledges, full autonomy returns, Guardians deactivate except always-on rules.

Experimental-sandbox doesn't transition; sandboxes are either kept as permanent scratch or retired.

## Multi-project installations

Each project has its own stage. Atelier supports:
- One project in `pre-mvp` while another (e.g., Atelier itself) is `post-mvp`
- Simultaneously. Classifier + Guardian behavior differs per project.
- Agent's spawn loads the current project's stage along with its principles.

## Days-to-production counter

- Set at MVP Plan approval time (target ship date)
- Visible on Canvas (side panel or top bar)
- Feeds agent's urgency calibration: "14 days to ship, 23 nodes remaining, 8 in progress"
- On-track / behind / ahead status based on burn rate
- At MVP ship, counter retires; post-MVP cadence view replaces it

This is the motivation engine. The moat piece about ship-focus comes alive here.

## What applies in every stage (non-negotiable)

Some discipline applies regardless of stage:

- **Destructive actions flag, never auto-execute**
- **Raw capture always on**
- **Reflection pass at session end always on**
- **Personal brain writes (confidence-tagged)**
- **Secrets Guardian (`no_secrets_in_config`) always active**
- **Fatigue awareness** (Drafter)
- **Transparency** (every move visible on Canvas)

---

_Stages.md modulates Classification and Guardians. Applied by both Drafter and Implementer based on the active project's stage flag._
