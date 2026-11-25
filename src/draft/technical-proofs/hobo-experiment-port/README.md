# HoBo experiment port POC

This draft implements HOBO-304: the OpenExperiment-shaped `hobo:experiment`
port contract. It is intentionally isolated from the future product monorepo.

## Scope

- WIT package `hobo:experiment@0.1.0`.
- Assignment from a multivariate flag variant, carrying the source `flagKey`.
- Experiment definitions with variants, primary metrics, guardrail metrics, and
  sample-ratio markers.
- `experiment.Assigned`, `experiment.Exposed`, and `experiment.Concluded` event
  payloads, preserving sampled markers on assignment and exposure events.
- Minimal contract helper for validating definitions, recording exposures only
  for the assigned subject, returning typed exposure errors, and returning typed
  analysis results.

## Out of scope

- Assignment engine storage or rule evaluation.
- Metrics pipeline, statistical analysis implementation, and peeking controls.
- Statsig, GrowthBook, Optimizely, Eppo, and Amplitude adapters.
- Training-engine or eval-loop integration.

## Verification

```powershell
npm.cmd install
npm.cmd test
```

`npm.cmd test` runs `jco types` against `wit/world.wit`, then executes the
Node conformance tests.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Experiment Port.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
