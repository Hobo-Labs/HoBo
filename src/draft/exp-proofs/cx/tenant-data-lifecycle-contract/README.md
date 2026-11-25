# Tenant Data Lifecycle Contract

Executable M0 proof for HOBO-492, defining the v1 tenant data inventory, deletion/export and
account-closure obligations, retention posture, residency sensitivity, and customer-assurance
handoffs before downstream lifecycle implementation work fans out.

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\tenant-data-lifecycle-contract test
```

## Proof Surface

- `TENANT_DATA_LIFECYCLE_SCOPE` records goal, data classes, retention posture,
  deletion/export expectation, residency sensitivity, owner, v1 limitation, deletion/account-closure
  obligation states, dependencies, M1 evidence, and follow-up gate.
- `validateTenantDataLifecycleScope` fails closed when M0 scope drifts into legal approval, live
  deletion automation, storage implementation, or support/customer-data access.
- `canCreateTenantDataFollowUp` blocks M1-M4 follow-up work until M0 scope evidence is accepted.
- `classifyTenantDataLifecycleDecision` routes adjacent legal/privacy, security, backup/restore,
  support, provenance, or compliance work to the owning initiative.

## Architecture Guardrail Evidence

- PACT: `architecture/pacts/tenant_data_lifecycle_contract.pact.json` fixes the Compliance Evidence
  Pack consumer and tenant-data-lifecycle provider boundary.
- Protobuf + CUE: `architecture/tenant_data_lifecycle_contract.proto` and
  `architecture/tenant_data_lifecycle_contract.cue` define the record shapes and constraints for the
  lifecycle contract.
- Parse, don't validate: downstream M1 code must parse these records into derived domain types for
  data class id, obligation state, retention class, residency sensitivity, and owner route before
  any workflow consumes them.
- Event architecture: the command `TenantDataLifecycleScopeCommand` is submitted by the compliance
  owner actor, accepted as `TenantDataLifecycleScopeAccepted` or denied as
  `TenantDataLifecycleScopeDenied` events, appended to the compliance event store, projected into
  customer-assurance and support materialized views, captured as launch snapshots, and exposed
  through read stores for privacy, support, and security review.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Inventory lists customer data classes, telemetry, logs, generated artifacts, support data, billing data, and audit data. | Tests assert the required `dataClasses` ids. |
| Each class records retention, deletion/export expectation, residency sensitivity, owner, and v1 limitation. | Tests assert all lifecycle fields exist for every data class. |
| Deletion/account-closure obligations distinguish manual, supported, deferred, and impossible-with-rationale cases. | Tests assert the five deletion obligation states and their owner/audit/customer-message fields. |
| Links to legal/privacy, security, backup/restore, and support projects are included. | Tests assert design references and owning-initiative dependencies. |

## Scope Guards

This proof deliberately does not approve legal terms, implement live customer deletion/export,
build storage retention or purge jobs, grant support production data access, implement billing, or
publish customer assurance claims without accepted evidence.
