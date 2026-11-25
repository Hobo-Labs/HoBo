# HOBO-268 Saga Compensation Engine Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[ADR-0004](../../adr/01-architecture-core.md#adr-0004).

The executable POC in
[`src/draft/technical-proofs/saga-compensation-engine-contract`](../../../../src/draft/technical-proofs/saga-compensation-engine-contract)
proves the M2 saga compensation engine:

- a failure past the no-go threshold emits `deployment.RolledBack`;
- resources that reached `resource.Provisioned` compensate in reverse topological order;
- retries replay safely and skip resources already compensated, preventing double-destroy;
- optional resource failures do not roll back required resources;
- ambiguous provider state is refreshed before destroy;
- never-provisioned resources are skipped;
- cyclic resource graphs fail closed.

Scope kept out: compensation-of-compensation escalation depth, deployment-strategy templates, and
drift-driven reconcile.
