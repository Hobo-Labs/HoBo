# Choreography Saga Engine Contract

Independent POC for HOBO-249. It pins the M1 choreography saga semantics over an event log without
building the compensation algorithm, deployment strategy templates, spend/degradation sagas, or the
DeploymentView dashboard projection.

The contract proves:

- `saga.Started`, `saga.StepCompleted`, `saga.StepFailed`, `saga.Completed`,
  `saga.Compensating`, and `saga.RolledBack` are enough to reconstruct saga state.
- Replay returns recorded step results and does not call step side effects again.
- The no-go threshold hook consumes the failure taxonomy contract and enters the compensation seam
  for fatal failures.
- Every emitted saga event carries the same `correlationId` and chains `causationId` from the
  previous accepted event.
- A lost `saga.StepCompleted` append can be retried through the idempotency ledger without
  re-running the provider effect.
- Stale actor leases fail before a racing actor can run the same saga step.
- Events that arrive after rollback are ignored as terminal-saga input.

Run:

```sh
npm.cmd --prefix src/draft/technical-proofs/choreography-saga-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Choreography Saga Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
