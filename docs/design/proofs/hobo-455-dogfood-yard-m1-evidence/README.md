---
type: Reference
title: "HOBO-455 Dogfood Yard M1 Evidence Proof"
description: "Source issue: HOBO-455."
tags: [hobo, design]
---

# HOBO-455 Dogfood Yard M1 Evidence Proof

HOBO-455 is proven by the focused M1 contract at
[`src/draft/exp-proofs/dx/dogfood-yard-m1-evidence-contract`](../../../../src/draft/exp-proofs/dx/dogfood-yard-m1-evidence-contract/README.md)
and the durable source record at [dogfood-yard.md](../../dogfood-yard.md).

## Acceptance Evidence

- Required M1 dogfood/alpha evidence is listed and mapped to owning projects.
- Hosted preview, self-host seed handover, upgrade/rollback, and incident restore scenarios each
  name deterministic fixture evidence and release-cutline impact.
- Gap routes distinguish beta blockers, launch notes, and follow-up work.
- Cross-project dependencies route to release cutline, release notes, admin, bootstrap, and
  reliability owners.
- Follow-up execution issues are allowed only where evidence is missing.

## Negative Coverage

- Scope parser rejects Yard runtime build work.
- Scope parser rejects production provider calls and provider/live cloud execution claims.
- Scope parser rejects live customer data in evidence.
- Scope parser rejects beta or GA readiness claims.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\dogfood-yard-m1-evidence-contract test
```
