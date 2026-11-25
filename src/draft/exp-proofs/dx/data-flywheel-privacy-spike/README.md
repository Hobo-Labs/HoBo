# Data-flywheel privacy spike

Proof package for HOBO-364. It records the recommended capture, retention,
tenant-isolation, and opt-out rules for OpenInference trajectory capture before
the runtime implementation slices build the store or trainer.

Run the executable proof:

```bash
npm.cmd --prefix src/draft/exp-proofs/dx/data-flywheel-privacy-spike test
```

The package is deliberately dependency-free and models the decision in
`fixtures/privacy-model.json` plus the pure functions in `src/privacy-model.ts`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Data Flywheel Privacy Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
