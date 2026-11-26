# HOBO-382 DeploymentView Saga Graph Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-11](../../data-plane.md#plan-11),
[PLAN-07](../../developer-experience.md#plan-07), and
[ADR-0003](../../adr/01-architecture-core.md#adr-0003) /
[ADR-0004](../../adr/01-architecture-core.md#adr-0004).

The executable POC in
[`src/draft/technical-proofs/deployment-view-saga-graph-contract`](../../../../src/draft/technical-proofs/deployment-view-saga-graph-contract/README.md)
proves the GA DeploymentView projection boundary:

- replaying control-plane events reconstructs the deployment saga DAG, per-node
  state, rollback subgraph, and timeline;
- `match.Decided` rationale is surfaced per node for "why this infra";
- `hobo inspect run <id>` style queries read the event store by correlation id
  and never touch live providers;
- missing `correlationId` / `causationId` fails the end-to-end assertion;
- out-of-order delivery converges, concurrent deployments remain isolated, and
  in-flight runs render honestly as partial.

Scope kept out: dashboard UI, Streamer realtime push, provider reads, and
cross-deployment/fleet rollups.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\deployment-view-saga-graph-contract test
```
