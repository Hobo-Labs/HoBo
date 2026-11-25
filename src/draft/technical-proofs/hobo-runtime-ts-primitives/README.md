# Hobo Runtime TS Primitives (draft POC)

Independent draft POC for **HOBO-600** (S1-11). Implements Layer-4 runtime primitives —
`workflow`, `step`, `actor`, `saga`, `sleep`, hooks, streams, `ctx`, and error types — as
event-sourced executions over draft runtime-port mocks.

Promotes:

- `src/draft/technical-proofs/hobo-runtime-primitives/` (WIT / SDK_PRIMITIVE_TABLE)
- `src/draft/technical-proofs/camp-eventstore-runtime-port-contract/` (EventStore)
- `src/draft/technical-proofs/actor-host-runtime-port-contract/` (ActorHost)
- `src/draft/technical-proofs/replay-live-equivalence-poc/` (replay == live)
- `src/draft/technical-proofs/choreography-saga-engine-contract/` (saga choreography)

Production target: `packages/runtime/` (`@hobo/runtime`) + `packages/events/` facade when blockers merge.

## Run

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/hobo-runtime-ts-primitives
```

## Architecture Evidence

See [`ADR.md`](./ADR.md), [`architecture/`](./architecture), and [`architecture/pacts/`](./architecture/pacts).

## Event catalog (fixed)

`run.Started` · `run.StepScheduled` · `run.StepCompleted` · `run.StepFailed` · `run.SleepScheduled` ·
`run.HookCreated` · `run.HookResumed` · `run.Suspended` · `run.Completed` · `run.Failed` ·
`actor.Activated` · `actor.StateAppended` · `actor.Passivated` · `saga.Started` · `saga.StepEmitted` ·
`saga.Compensated` · `saga.Completed`
