# HOBO-249 Choreography Saga Engine Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[ADR-0004](../../adr/01-architecture-core.md#adr-0004).

The executable POC in
[`src/draft/technical-proofs/choreography-saga-engine-contract`](../../../../src/draft/technical-proofs/choreography-saga-engine-contract)
proves the M1 event-sourced choreography saga skeleton:

- a three-step saga reaches `Completed` and reconstructs from `saga.*` events;
- replay returns memoized step results without re-executing provider side effects;
- fatal failure taxonomy classifications cross the no-go threshold and emit the compensation seam;
- `correlationId` is stable across every saga event and `causationId` chains through accepted
  events;
- lost `saga.StepCompleted` append retry is idempotent through a memoized effect ledger;
- stale actor fencing rejects a racing actor before duplicate step execution;
- late events for an already rolled-back saga are ignored.

Scope kept out: the compensation algorithm body, deployment strategy templates, spend/degradation
sagas, and the DeploymentView dashboard projection.
