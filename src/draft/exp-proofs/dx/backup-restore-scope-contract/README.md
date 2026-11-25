# Backup & Restore Scope Contract

Executable M0 proof for HOBO-429, defining Backup & Restore scope and acceptance before later
design or implementation work fans out.

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\backup-restore-scope-contract test
```

## Proof Surface

- `BACKUP_RESTORE_SCOPE` records goal, personas, scope in/out, non-goals, boundaries, backup
  sources, restore paths, dependencies, M1 evidence, and follow-up gate.
- `validateBackupRestoreScope` fails closed when M0 scope drifts into production backup storage,
  restore execution, live customer data, cloud storage backend work, scheduler work, or compliance
  approval.
- `classifyBackupRestoreDecision` routes adjacent decisions to Provenance & Retention, Upgrade &
  Migration Engine, Support Workflow, Compliance Evidence Pack, or Backup & Restore.
- `canCreateBackupRestoreFollowUp` blocks M1-M4 follow-up issues until M0 scope evidence is
  accepted.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and five persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays are exported and validated for creep. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateBackupRestoreFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not build backup storage, restore services, cloud storage backends,
snapshot scheduling, live customer recovery, upgrade/migration rollback runners, support queues, or
compliance approval workflows.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Backup Restore Scope Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
