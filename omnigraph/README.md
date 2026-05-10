# OmniGraph (vendored)

This is a vendored, scope-trimmed copy of OmniGraph — the writer side of the brain-integration contract Atelier reads (see [`../docs/BRAIN_INTEGRATION.md`](../docs/BRAIN_INTEGRATION.md)).

**This is not the upstream.** OmniGraph as a standalone OSS project lives at TBD (clean publication forthcoming). This vendored copy contains only what Atelier needs: harvest adapters for Claude / Gemini / Qwen-Code / Cursor / Cline / Antigravity / ChatGPT, the 3-layer brain compiler, and the per-project domain-brain compile.

## What's in scope here

- `src/compiler/` — emits `light_ir.global.xml` + `light_ir.personal.xml`
- `src/sources/` — provider transcript adapters
- `src/domain_brain/` — per-project `projects/<slug>/brain.xml`
- `src/omnigraph_cli.py` — unified CLI invoked by `bin/informed-vibe brain ...`
- `scripts/etl_daemon.py` — optional 10-min refresh daemon
- `scripts/emit_og_artifacts.py` — `og_artifacts/` emit pipeline
- `scripts/session_harvester.py` — provider transcript harvester
- `scripts/dedup_global_profile.py` — post-aggregate dedup

## What's NOT here

If you need any of these, see the standalone OmniGraph repo (when published):

- Visualization (`src/viz/` — brain-map renderers / image export)
- Codebase-intelligence adapter (`src/hr/`, `src/hr_adapter/`) — out-of-scope for this vendoring
- Analysis lenses (`src/lenses/` — six-lens prompts)
- Reflect worker (`src/reflect.py` — lens-driven per-session reflection)

## Running

Through Atelier's CLI (recommended):

```bash
./bin/informed-vibe brain init
./bin/informed-vibe brain compile
./bin/informed-vibe brain daemon  # optional, refreshes every 10 min
```

Direct (debug):

```bash
cd omnigraph
python3 src/omnigraph_cli.py status --atelier-root ../ --user-id default
python3 src/omnigraph_cli.py compile light_ir_global \
  --atelier-root ../ --user-id default
```

## Output contract

When invoked with `--atelier-root <ROOT> --user-id <uid>`, OmniGraph writes the 3-layer brain to where Atelier's reader (`backend/src/session/load-omnigraph-brain.ts`) expects:

- `<ROOT>/data/users/<uid>/brain/personal/compiled/light_ir.global.xml`
- `<ROOT>/data/users/<uid>/brain/personal/compiled/light_ir.personal.xml`
- `<ROOT>/data/users/<uid>/brain/personal/compiled/projects/<slug>/brain.xml`

The vendored CLI wrapper (`bin/informed-vibe brain`) passes these flags automatically with `user-id=default`.

Full spec: [`../docs/BRAIN_INTEGRATION.md`](../docs/BRAIN_INTEGRATION.md) and [`../docs/OMNIGRAPH_FILE_DROP_CONTRACT.md`](../docs/OMNIGRAPH_FILE_DROP_CONTRACT.md).

## Requirements

- Python ≥3.10
- Deps in `requirements.txt` (`pyyaml`, `json_repair`)
- For Stage-1 extraction (optional): a local OpenAI-compatible LLM endpoint (LM Studio / llama.cpp / Ollama). Default `http://localhost:1234/v1`.

## License

Apache 2.0 — see top-level [`../LICENSE`](../LICENSE).
