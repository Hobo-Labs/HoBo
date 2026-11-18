# Generation Pipeline, Training, and AI Safety

The executable simulation composes provider generation, contract fill,
no-egress validation, bounded repair, certification, trajectory capture,
privacy filtering, optimization, live evaluation, poisoning controls,
human approval, and cross-layer propagation.

Generated provider source is imported and exercised with a database driver
before certification evidence is returned. Pact files under `contracts/pacts/`
cover every service boundary exposed by the simulation.

Run:

```bash
pnpm --prefix src/draft/epic-proofs/generation-pipeline-training-ai-safety test
pnpm --prefix src/draft/epic-proofs/generation-pipeline-training-ai-safety run simulate
```
