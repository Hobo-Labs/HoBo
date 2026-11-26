---
type: Reference
title: "HOBO-492 Tenant Data Lifecycle M0 Proof"
description: "Source issue: HOBO-492."
tags: [hobo, design]
---

# HOBO-492 Tenant Data Lifecycle M0 Proof

This proof package demonstrates that HOBO-492 records accepted M0 tenant data lifecycle inventory,
deletion/export obligations, retention posture, residency sensitivity, and owner handoffs before
follow-up implementation work can fan out.

## Evidence

- Design record:
  [`docs/design/tenant-data-lifecycle.md`](../../tenant-data-lifecycle.md)
- Executable contract:
  [`src/draft/exp-proofs/cx/tenant-data-lifecycle-contract`](../../../../src/draft/exp-proofs/cx/tenant-data-lifecycle-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
npm.cmd --prefix src\draft\exp-proofs\tenant-data-lifecycle-contract test
```

The check proves the HOBO-492 acceptance bullets and scope boundaries:

- customer product data, telemetry, logs, generated artifacts, support data, billing data, and audit
  data are all inventoried;
- each data class names retention, deletion/export expectation, residency sensitivity, owner, and
  v1 limitation;
- deletion and account-closure obligations distinguish supported export, supported delete, manual
  review, deferred retention, and impossible-with-rationale states;
- legal/privacy, security, backup/restore, support, provenance, and tenant-isolation handoffs are
  linked;
- M1-M4 follow-up work is blocked until M0 acceptance;
- scope creep into final legal approval, live deletion automation, storage implementation, support
  customer-data access, billing, or SIEM workflows is rejected.
