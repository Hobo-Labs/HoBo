# @hobo/provider-ax contracts

The boundary this package provides is the `hobo:training-engine` port
(ADR-0025 / ADR-0125): `optimize(OptimizeRequest) -> TrainingCandidate` (generated proto types from `@hobo/core`).

- `pacts/training_engine_optimize.pact.json` — the port boundary pact: an
  optimize request over recorded trajectories yields a provenance-pinned
  artifact candidate. The provider side is exercised directly by
  `test/engine.test.ts` (the engine parses its boundary with
  `parseOptimizeRequest` and re-parses its own output with
  `parseTrainingCandidate`, so an engine bug cannot emit an out-of-contract
  candidate).

The engine is internal (never SDK surface); consumers are the Yard's
training loop, not app code.
