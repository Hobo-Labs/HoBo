# HOBO-61 Planner DAG Skeleton Proof

This executable proof pins the Planner resource-collection DAG slice from
[Plan 04](../../control-plane.md#plan-04), [Plan 25](../../platform-engineering.md#plan-25),
and the Collector handoff described in [architecture.md](../../architecture.md).

## Contract Surface

- Fixture manifest IR lowers into skeletal `DeploymentPlan` resource nodes.
- Manifest `links` and `bind` entries become dependency DAG edges.
- Cyclic inputs fail closed with a precise cycle path.
- Co-provisioned child resources are expanded into explicit nodes and edges.
- `deployment.Planned` is emitted and its `planHash` content-addresses the plan.

## Adversarial Coverage

- Empty manifest resources are rejected.
- Duplicate resource ids are rejected before planning.
- Missing `bind` targets are rejected with the missing id.
- Self-referential resources are rejected.

## Scope Boundary

This proof intentionally does not implement ResourceDefinition matching,
capability negotiation, region/objective ranking, provider resolution, or
manifest IR production. Those remain owned by later matching, SDK, and provider
slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\planner-dag-skeleton-contract test
```
