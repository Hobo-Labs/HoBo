# HOBO-620 Orchestrator reconciliation FSM draft POC

Independent proof for **S2-05**: Orchestrator + ResourceActors with reconciliation FSM
and compensation sagas. Promotes reconciliation/drift/rollback scenarios from
[`control-plane-planner-matching-orchestrator`](../../epic-proofs/control-plane-planner-matching-orchestrator/README.md)
without waiting for S2-04 Planner production code.

## Scope

- One **ResourceActor** per plan resource with FSM:
  `Pending → Planning → Provisioning → Provisioned | Failed → Compensating → Destroying → Destroyed`
- **Orchestrator** choreography: DAG-order provisioning via dependency satisfaction
- **Compensation saga**: mid-DAG failure triggers `deployment.RolledBack` and reverse-dependency destroy
- **ActorHost** lease fencing before Provisioning transitions (S1-06 port shape)
- **Mocked executor** apply/destroy boundary (no live IaC/cloud)
- **Event replay** to identical actor state (NFR-011)

## Out of scope

- Production `packages/cloud/src/orchestrator/` (blocked on S2-04 merge)
- Live EventStore, real Pulumi/Terraform executors, drift refresh loop
- Planner IR ingestion (uses local fixture DeploymentPlan)

## Design refs

- [`docs/design/control-plane.md`](../../../../docs/design/control-plane.md) Plan 04
- [`docs/design/architecture.md`](../../../../docs/design/architecture.md) request lifecycles
- Prior proofs: `resourceactor-fsm-contract`, `orchestrator-choreography-skeleton-contract`, `choreographed-compensation-contract`

## Validation

```bash
pnpm --prefix src/draft/technical-proofs/orchestrator-reconciliation-fsm-contract test
pnpm run test:file src/draft/technical-proofs/orchestrator-reconciliation-fsm-contract/test/orchestrator-reconciliation-fsm.test.ts
```

## Architecture evidence

- `architecture/` — protobuf + CUE + PACT boundary
- `ADR.md` — parse-don't-validate and event replay evidence

## Promotion path

When S2-04 Planner merges, promote this POC into `packages/cloud/src/orchestrator/` with
protobuf/CUE contracts lifted from the draft package.
