# Brain integration (OmniGraph)

Atelier's "brain" is a 3-layer set of files (global / personal / project) that the backend reads at session boot and injects into the CLI subprocess as context. Atelier is the **reader**; OmniGraph is the **writer**.

OmniGraph is a separate OSS project: https://github.com/Amitshukla2308/omnigraph (in progress; this doc tracks the contract).

## Why a brain at all?

A chat window forgets. A brain remembers what the founder is building, who they are, and how they think. Across sessions, across providers.

## The 3-layer split

| Layer | Where it lives | Who writes it | Scope |
|---|---|---|---|
| Global | `~/.informedvibe/og_artifacts/global/` | OmniGraph | Generic principles distilled from the founder's chats |
| Personal | `~/.informedvibe/og_artifacts/personal/` | OmniGraph | Founder identity, role, recurring concerns |
| Project | `<atelier>/projects/<P>/brain.xml` | Atelier (canonical) or OmniGraph (fallback) | Project-specific facts |

The split is intentional — mixing them historically caused hallucinations.

## File-drop contract

The contract is detailed in [OMNIGRAPH_FILE_DROP_CONTRACT.md](./OMNIGRAPH_FILE_DROP_CONTRACT.md). Summary:

- OmniGraph writes files under `~/.informedvibe/og_artifacts/` on its own schedule (cron / daemon / one-shot).
- Atelier scans that directory at session boot. Missing files = no brain layer for that session (graceful degradation).
- File names and shapes are fixed; new layers are additive.

## Running without OmniGraph

Atelier works without a brain — the agent just won't have founder context. The onboarding flow still asks for `agent_name`, `founder_name`, etc. and uses them as a minimal in-process brain.

## Running with OmniGraph

1. Install OmniGraph: see its README.
2. Run a one-shot compile: `omnigraph init && omnigraph compile --target informed-vibe`.
3. Restart Atelier — the brain reader picks up the new files automatically.
4. Optional: run `omnigraph daemon` to keep the brain fresh as you have new conversations.
