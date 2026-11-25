# @hobo/provider-ax

The built-in `hobo:training-engine` implementation (ADR-0025 "built-in-opto"),
built on [ax (`@ax-llm/ax`)](https://github.com/ax-llm/ax) per ADR-0125.
`createAxTrainingEngine` returns a `TrainingEnginePort` whose `optimize()` runs
ax's GEPA/bootstrap optimization over recorded trajectories and emits a
provenance-pinned `TrainingCandidate` with a serialized optimized program.
Engine-internal: selected behind the WIT port per tenant/Camp, never part of
the SDK surface. See [`ADR.md`](./ADR.md).

## Honest scope

Implemented: the port adapter over ax (pinned exactly at `22.0.9`, asserted
against the installed package by `test/engine.test.ts` so the pin cannot drift),
demo selection from trajectories at or above the `0.9` reward floor, and the
engine-internal payload proto. The AI service ax optimizes against is
caller-injected per tenant/Camp — this package ships no model, no keys, and no
ambient credentials. It holds no run state and starts no training loop of its
own.

## Commands

```bash
pnpm --filter @hobo/provider-ax run build
pnpm --filter @hobo/provider-ax run typecheck
pnpm --filter @hobo/provider-ax run lint
pnpm --filter @hobo/provider-ax run test
```

## Parse, don't validate

The engine boundary crosses two parsers and only derived types flow between
them: `optimize()` re-parses even trusted callers with core's
`parseOptimizeRequest` (frozen `OptimizeRequest`) and re-parses its own output
with `parseTrainingCandidate`, so an engine bug can never emit an
out-of-contract `TrainingCandidate` — parse, don't validate. Trajectory hashes
are canonical derived sha256 values via `hashTrajectory`. Port record wire
forms live in `@hobo/core`'s `data-models/training_engine.proto`; the local
`data-models/ax_engine_payload.proto` (with CUE constraints) covers only the
engine payload.

## Position in the event architecture

The engine is a pure function over recorded execution; it hosts no actor and
appends nothing itself. In the platform loop, `RequestOptimization` is the
command; the Yard's training-run actor owns run state and calls this engine
behind the port; trajectories are read from and candidates appended to the
platform event store (the candidate rides `training.CandidateProposed`); the
training-run projection folds `training.*` events into run status, and the
provenance-pinned artifact is the snapshot a promotion applies at load.
