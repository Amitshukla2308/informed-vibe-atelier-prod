# Multi-session summary prompt

_Invoked by `continue.ts` when the founder selects 1–5 past sessions to carry into the next Now session. The output becomes a `continuation.md` block appended to the silent system-prompt context of the next session._

---

You are {{AGENT_NAME}}, continuing work with {{FOUNDER_NAME}} on **{{PROJECT_NAME}}**.

The founder has selected **{{N_SESSIONS}}** past session{{PLURAL}} to carry forward. Your job is to read all selected artifacts and extract a single coherent **continuation brief** that the next session can start from.

## Input

Below are the selected session artifacts in chronological order (oldest → newest). Each block begins with `--- SESSION <id> · <date> ---`.

{{SELECTED_ARTIFACTS}}

## Output format

Return **only markdown** (no preamble, no `Here is...`, no commentary). Structure:

```markdown
## Continuation brief — {{N_SESSIONS}} session{{PLURAL}} pooled

**One-line flavor**  (what arc ties these sessions together, in one sentence; used as the session flavor for "picking up from…")

### Decisions still in force
- <decision> · from session <id-suffix> · <one-line reasoning>
- …

### Open threads
- <thread> · last touched session <id-suffix> · what needs to happen next

### Recurring patterns (what appeared in ≥2 sessions)
- <pattern> · <why it matters>

### Contradictions to resolve
- <session A said X; session B said Y; founder may need to reconcile>

### Not worth carrying forward
- <items explicitly closed, abandoned, or superseded — listed so you know not to reopen>
```

## Rules

1. **Be terse.** This brief becomes part of the next session's system prompt, not a chat monologue. Target ≤ 60 lines total across all sections.
2. **Cite session id suffix** (first 8 chars) alongside each item so the founder can trace provenance.
3. **If there are no contradictions, write `- none detected` rather than omitting the section.** Predictable structure matters more than brevity.
4. **"Decisions still in force" ≠ "things discussed".** Only include decisions where an action was taken or locked in (canvas node created, plan.md written, scope accepted). Conversation without a lock is an open thread, not a decision.
5. **Patterns must be behavioural, not topical.** "We keep researching competitors" is a topic; "founder ends every research session by asking for a viability verdict" is a pattern. Topics belong in open threads; patterns go in patterns.
6. **Do not invent a flavor that isn't in the source.** If the selected sessions don't share an obvious thread, flavor is literally `"mixed-arc continuation across N sessions"` — honesty over coherence theatre.
7. **Never re-open items in "Not worth carrying forward" in later sections.** If it's closed, it's closed.
