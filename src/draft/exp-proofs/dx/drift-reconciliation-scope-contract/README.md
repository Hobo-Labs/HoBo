# Drift Reconciliation Scope Contract

Executable M0 proof for HOBO-442, defining Drift Reconciliation scope and acceptance before later
design or implementation work fans out.

The authoritative design record is
[`docs/design/drift-reconciliation.md`](../../../../docs/design/drift-reconciliation.md).

## Focused Gate

```powershell
pnpm --prefix src\draft\drift-reconciliation-scope-contract test
```

## Proof Surface

- `DRIFT_RECONCILIATION_SCOPE` records goal, personas, scope in/out, non-goals, boundaries, drift
  classes, reconciliation states, required evidence, dependencies, M1 evidence, and follow-up gate.
- `validateDriftReconciliationScope` fails closed when M0 scope drifts into provider refresh,
  ResourceActor runtime, autonomous remediation, destructive cleanup, support tooling, or billing.
- `classifyDriftReconciliationDecision` routes adjacent decisions to their owning initiatives.
- `canCreateDriftReconciliationFollowUp` blocks M1-M4 follow-up issues until M0 acceptance.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and four persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays are exported and validated for creep. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Seven M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateDriftReconciliationFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not build provider refresh schedulers, live provider polling,
ResourceActor runtime changes, autonomous remediation, real cloud mutation, destructive cleanup,
support ticketing, billing adjustment, or customer notification implementation.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Drift Reconciliation Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
