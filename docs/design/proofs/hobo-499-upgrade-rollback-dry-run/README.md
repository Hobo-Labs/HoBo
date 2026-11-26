---
type: Reference
title: "HOBO-499 Upgrade Rollback Dry-Run Contract Proof"
description: "Source issue: HOBO-499."
tags: [hobo, design]
---

# HOBO-499 Upgrade Rollback Dry-Run Contract Proof

This proof package demonstrates the M1 Upgrade & Migration Engine dry-run contract for rollback and
migration compatibility evidence.

## Evidence

- Design record:
  [`docs/design/upgrade-migration-engine.md`](../../upgrade-migration-engine.md)
- Executable contract:
  [`src/draft/technical-proofs/upgrade-rollback-dry-run-contract`](../../../../src/draft/technical-proofs/upgrade-rollback-dry-run-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
npm.cmd --prefix src\draft\technical-proofs\upgrade-rollback-dry-run-contract test
```

The check proves the HOBO-499 acceptance bullets and scope boundary:

- preflight, compatibility, backup, migration plan, rollback, unsupported-path, release-note, and
  support-handoff fields exist in the dry-run report;
- deterministic fixtures cover clean upgrade, blocked upgrade, failed migration, and rollback-ready
  paths;
- blocked and failed reports carry customer-safe support/release evidence with zero mutation
  commands; and
- live migration, rollback executor, provider-state rewrite, and support automation requests are
  rejected instead of silently expanding scope.
