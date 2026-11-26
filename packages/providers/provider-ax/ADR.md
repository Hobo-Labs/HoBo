# @hobo/provider-ax — Architecture Evidence

The built-in `hobo:training-engine` implementation (ADR-0025 "built-in-opto"),
built on [ax (`@ax-llm/ax`)](https://github.com/ax-llm/ax) per
[ADR-0125](../../../docs/design/adr/03-data-plane.md#adr-0125): typed
signatures + GEPA/bootstrap `optimize()` + serialized-optimized-program
training artifacts. Engine-internal: selected behind the WIT port per
tenant/Camp, never part of the SDK surface; swapping engines is
configuration.

## Schema and constraints

- Record shapes are the **generated** proto types: the port records
  (trajectory, optimize request, candidate, artifact program) come from
  `@hobo/core`'s `data-models/training_engine.proto`; this package's own
  [`data-models/ax_engine_payload.proto`](./data-models/ax_engine_payload.proto)
  describes only the engine-internal payload stored in the platform
  program's `engine_payload_json`. Codegen is opted in via
  `data-models/buf.yaml`; generated types live in `src/_generated/`.
- CUE constraints bound every protobuf type in
  [`data-models/ax_engine_payload.cue`](./data-models/ax_engine_payload.cue).
- PACT boundary evidence for the optimize edge lives under
  [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

The engine's boundary crosses two parsers and only derived types flow
between them: `optimize()` re-parses even trusted callers with
`parseOptimizeRequest` (deep-frozen parsed generated `OptimizeRequest`),
and re-parses its own output with `parseTrainingCandidate`, so an engine
bug can never emit an out-of-contract candidate. Trajectory hashes are
canonical proto-JSON sha256 derived values (`hashTrajectory`, `@hobo/core`).

## Event architecture

The engine is a pure function over recorded execution; the training loop
around it is event-sourced (Plan 23 / `event-families.md`):

- **Command** — `RequestOptimization` submits an optimize request for one
  trainable method's generated region.
- **Event** — `training.RunStarted` … `training.CandidateProposed` carry the
  run; the candidate this engine returns rides `training.CandidateProposed`.
- **Actor** — the Yard's training-run actor owns run state and calls this
  engine behind the port; the engine itself holds no state.
- **Event store** — trajectories are read from, and candidates appended to,
  the platform event store (trajectories ride the event log, ADR-0099).
- **Materialized view / projection** — the training-run projection folds
  `training.*` events into run status for the dashboard.
- **Snapshot** — the provenance-pinned training artifact is the snapshot a
  promotion applies at instantiation (ADR-0125 apply-at-load).
- **Read store** — champion/challenger eval comparisons query the training
  read store; promoted artifacts are fetched from the artifact store.
