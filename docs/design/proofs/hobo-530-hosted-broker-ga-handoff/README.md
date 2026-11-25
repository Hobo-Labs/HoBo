---
type: Reference
title: "HOBO-530 Hosted Broker GA Handoff Proof"
description: "Source issue: HOBO-530."
tags: [hobo, design, proof]
---

# HOBO-530 Hosted Broker GA Handoff Proof

HOBO-530 is proven by the focused M4 contract at
[`src/draft/exp-proofs/cx/hosted-broker-ga-handoff-evidence-contract`](../../../../src/draft/exp-proofs/cx/hosted-broker-ga-handoff-evidence-contract/README.md)
and the broker source record at [meta-cloud-broker.md](../../meta-cloud-broker.md#m4-hosted-broker-ga-handoff-evidence).

## Acceptance Evidence

- Required M4 evidence covers the operational owner checklist, Dogfood Yard readiness link,
  compatibility/versioning window, rollback/restore limits, and release-note/support entry.
- Evidence maps to owning projects and source records before it can pass the M4 gate.
- Resolution Receipt and Resolution Rejection evidence is linked to Dogfood Yard deploy-readiness
  questions without becoming live hosted broker GA proof.
- Compatibility windows cover receipt schema v1, Broker Environment snapshots, and catalog snapshot
  versions.
- Release notes and support docs have broker-specific entries and explicit non-goals.
- Parent release-readiness sync is required when launch risk changes.

## Negative Coverage

- Pending required evidence cannot pass the gate.
- Follow-up records may only point at missing evidence.
- A launch-risk change without parent initiative sync is rejected.
- GA claims based only on local fixtures or manually edited receipts are rejected.
- This proof cannot publish live hosted broker GA claims.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\hosted-broker-ga-handoff-evidence-contract test
```
