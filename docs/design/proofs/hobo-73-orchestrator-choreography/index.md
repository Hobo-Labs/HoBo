# HOBO-73 Orchestrator Choreography Skeleton Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0004](../../adr/01-architecture-core.md#adr-0004).

The executable POC in
[`src/draft/technical-proofs/orchestrator-choreography-skeleton-contract`](../../../../src/draft/technical-proofs/orchestrator-choreography-skeleton-contract)
proves the M1 orchestrator choreography skeleton:

- a DeploymentPlan fixture provisions in dependency order;
- independent root resources activate in the same wave;
- `deployment.Deployed` is emitted only after every resource reaches
  `resource.Provisioned`;
- `correlationId` is stable across every emitted event;
- stalled dependencies keep downstream actors waiting without blocking
  unrelated roots;
- duplicate `resource.Provisioned` events do not reactivate dependents;
- diamond dependencies activate the join actor once, after both inbound
  dependencies are provisioned.

Scope kept out: compensation or rollback choreography, periodic resync or drift
repair, incremental reconcile of changed nodes, and provider reconcile loop
bodies.
