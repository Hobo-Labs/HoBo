# HOBO-50 Deployment Set and Delta Projection Proof

This executable proof pins the M0 contract for `DeploymentSet` and `DeploymentDelta`
projections from [Plan 25](../../platform-engineering.md#plan-25).

## Contract Surface

- `DeploymentSet` is the immutable, content-addressed resolved config for one Camp.
- `DeploymentDelta` is a mutable diff against one base Set and one Camp.
- `set.Created` records a Set directly.
- `delta.Opened` starts a diff against an existing base Set.
- `delta.Updated` records add/update/remove changes against that base Set.
- `delta.Applied` closes the Delta and creates a new immutable Set.
- `envGroup` is a Yard-level orchestration membership type over Camps with the same
  logical environment type; it is not a new config layer or scope noun.
- Stateful resource replication topology is part of each resolved resource config.

## Proof Boundaries

This proof intentionally stops at the transition contract. It does not implement
Gatekeeper, promote/rollback sagas, incremental ResourceActor reconcile, or real
cross-Camp replication. Those remain owned by later M2 slices.

## Executable Checks

Run:

```powershell
node scripts\validate-deployment-set-delta.ts
```

The checks prove:

- folding `set.Created + delta.*` yields the expected Set and Delta projections,
- Set content addresses are stable across object key order changes,
- a Delta diff against a Set computes add/update/remove changes,
- overlapping open Deltas are rejected,
- stale Deltas cannot target a non-current Set,
- a Delta cannot update or remove a resource absent from the base Set,
- out-of-order Delta events are rejected,
- env-group membership rejects duplicate member Camps.
