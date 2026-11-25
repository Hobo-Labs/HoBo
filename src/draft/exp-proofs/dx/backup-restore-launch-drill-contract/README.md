# Backup Restore Launch Drill Contract

Executable M1 proof for HOBO-498. This package defines deterministic backup/restore launch-drill
evidence without building backup storage, restore services, schedulers, support workflow, or live
customer recovery.

## Focused Gate

```powershell
pnpm.cmd --dir src\draft\exp-proofs\backup-restore-launch-drill-contract test
```

## Proof Surface

- `BACKUP_RESTORE_LAUNCH_DRILL` records the accepted launch drill data sets, restore paths,
  RPO/RTO targets, evidence output, failure modes, rollback paths, and gap routes.
- `parseBackupRestoreLaunchDrill` returns a derived parsed record or explicit boundary errors before
  consumers can use drill evidence.
- `validateBackupRestoreLaunchDrill` fails closed when the M1 drill contract omits required
  fields or drifts into production restore services, backup storage, live customer data, or final
  compliance approval.
- `classifyBackupRestoreGap` routes gaps to Launch Support & Escalation, Customer Assurance /
  Legal Privacy, Bootstrap Installer, or Release Notes & Upgrade Guide instead of silently expanding
  Backup & Restore scope.
- `canClaimProductionRestoreReadiness` blocks any readiness claim until successful deterministic
  drill evidence exists and live customer data is not used.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Drill design names data sets, restore path, RPO/RTO target, evidence output, failure modes, and rollback path. | Tests assert five data sets, three restore paths, positive RPO/RTO targets, required evidence fields, failure-mode routing, and rollback or escalation paths. |
| Evidence distinguishes SaaS, self-host, and local/dev where applicable. | Tests assert one restore path for each launch context and context-specific evidence sources. |
| Gaps route to support, compliance, installation, or release notes. | Gap classifier routes owner handoffs without changing Backup & Restore ownership. |
| Scope out: no production restore claim without successful drill evidence. | Readiness guard rejects missing drill evidence and live customer data. |

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the launch drill contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
