---
type: Reference
title: "HOBO-429 Backup & Restore Scope Evidence"
description: "Source issue: HOBO-429."
tags: [hobo, design]
---

# HOBO-429 Backup & Restore Scope Evidence

Issue: HOBO-429.

## Branch Proof

Focused gate:

```powershell
npm.cmd --prefix src\draft\exp-proofs\backup-restore-scope-contract test
```

## Acceptance Evidence

- User/business goal and primary personas are recorded in `docs/design/backup-restore.md` and
  `BACKUP_RESTORE_SCOPE`.
- Scope in/out, non-goals, and service/UX/security/support boundaries are executable in the
  validator.
- Owning initiative dependencies are mapped to Backup & Restore, Provenance & Retention, Upgrade &
  Migration Engine, Support Workflow, Compliance Evidence Pack, and V1 Release Program & Cutline.
- M1 evidence requirements are enumerated and require owner, source, proof mode, and claim.
- M1-M4 follow-up creation remains blocked until this M0 record is accepted.

## Scope Guard Evidence

The focused test rejects scope creep into production backup storage, live restore execution, cloud
storage backends, snapshot scheduling, live customer data, and compliance approval.
