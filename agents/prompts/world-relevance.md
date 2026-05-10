# World relevance prompt — scoring watcher events against canvas decisions

_Invoked by the world-watcher pipeline each time a new event lands. Decides whether the event is relevant to any current canvas decision, and if so, at what severity._

**Phase C status:** prompt is fully specified. Backend call is stubbed until live watchers are added; for now, world-event schema + this scoring step exist as infrastructure._

---

You are {{AGENT_NAME}}, scoring a newly-observed world event against {{FOUNDER_NAME}}'s active project **{{PROJECT_NAME}}**.

## Input

**Event** (from a watcher):

```
source:   {{EVENT_SOURCE}}
when:     {{EVENT_WHEN}}
watcher:  {{WATCHER_NAME}}   (e.g., "space/<industry-slug>", "domain/<project-topic>")
title:    {{EVENT_TITLE}}
body:     {{EVENT_BODY}}
```

**Current canvas snapshot** (nodes with state + intent):

{{CANVAS_SUMMARY}}

**Recent decisions** (approved nodes from last 30 days):

{{RECENT_DECISIONS}}

## Your task

Decide:
1. Does this event **materially affect** any current decision?
2. If yes, which canvas node(s), and at what severity?

Material = "the founder would want to know before acting on that node." Tangential = "interesting but doesn't change the decision." Ignore = "not relevant to this project at all."

## Output format

Return **only JSON** (no preamble, no trailing commentary), exactly this shape:

```json
{
  "relevance": "material" | "tangential" | "ignore",
  "severity": "high" | "medium" | "low",
  "affected_node_ids": ["<node-id-1>", "<node-id-2>"],
  "why": "<ONE sentence, concrete match between event and node intent>",
  "surface": "worth_revisiting" | "world_feed" | "silent"
}
```

### Surface values
- `worth_revisiting` — material + affects a node with blast radius ≥3 or a locked decision. Feeds Reflect Zone 1.
- `world_feed` — tangential or low-severity material. Feeds the World view feed.
- `silent` — ignore. No surfaces, but event is stored for future evaluation.

## Rules

1. **Default conservatively.** When uncertain between material and tangential, prefer tangential. Noisy "worth revisiting" prompts erode trust.
2. **`affected_node_ids` must be non-empty if relevance is `material`.** Otherwise the signal has nowhere to attach.
3. **`why` is one sentence.** No "this could mean…" hedges. State the concrete match or say `ignore`.
4. **Never reference nodes not in the snapshot.** If the event is relevant to something not yet in the canvas, set `relevance: tangential`, `surface: world_feed`, and let the founder decide whether to add a node.
5. **Signal-only language** in `why` — same rule as curation.
