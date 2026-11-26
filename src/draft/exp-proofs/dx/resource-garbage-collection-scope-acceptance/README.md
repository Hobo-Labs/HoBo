# Resource Garbage Collection Scope Acceptance

Executable M0 proof for HOBO-443, defining Resource Garbage Collection scope and acceptance before
later design or implementation work fans out.

The authoritative design record is
[`docs/design/resource-garbage-collection.md`](../../../../../docs/design/resource-garbage-collection.md).

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\resource-garbage-collection-scope-acceptance test
```

## Proof Surface

- `RESOURCE_GARBAGE_COLLECTION_SCOPE` records goal, personas, scope in/out, non-goals, boundaries,
  garbage classes, cleanup states, required evidence, dependencies, M1 evidence, and follow-up gate.
- `validateResourceGarbageCollectionScope` fails closed when M0 scope drifts into provider adapter
  sweepers, live cloud deletes, production cleanup runtime, retention law, billing, or drift runtime.
- `classifyResourceGarbageCollectionDecision` routes adjacent decisions to their owning initiatives.
- `canCreateResourceGarbageCollectionFollowUp` blocks M1-M4 follow-up issues until M0 acceptance.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and four persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays are exported and validated for creep. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateResourceGarbageCollectionFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not build provider adapters, live sweepers, destructive cleanup
runtime, drift detection, rollback compensation, legal retention policy, billing, ticketing, or
customer notification implementation.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Resource Garbage Collection Scope Acceptance.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
