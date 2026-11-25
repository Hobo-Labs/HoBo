---
type: Design Proof Evidence
title: "HOBO-487 Customer Onboarding Script Proof"
description: "M0 proof record for customer onboarding script stages, success criteria, and pilot gating."
tags: [hobo, proof, customer-onboarding, onboarding-script]
timestamp: 2026-06-30T00:00:00Z
---

# HOBO-487 Customer Onboarding Script Proof

HOBO-487 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/customer-onboarding-script-contract`](../../../../src/draft/exp-proofs/cx/customer-onboarding-script-contract/README.md)
and the durable script record at [customer-onboarding.md](../../customer-onboarding.md).

## Acceptance Evidence

- Script stages cover invite, workspace setup, sample-or-real project choice, first deploy, failure
  recovery, support handoff, and feedback capture.
- Success criteria cover time-to-first-success, blocker categories, handoff quality, and unresolved
  risk.
- Pilot notes route to cutline, docs, product UX, support, or owning engineering surfaces.
- Future pilot usage is gated on accepted M0 evidence, script review, support owner, and customer
  consent.

## Negative Coverage

- Scope validation rejects onboarding automation, live customer data capture, support-tool
  implementation, and real deploy/provisioning creep.
- Stage validation rejects missing owner, proof mode, expected evidence, or source.
- The proof package does not run customer pilots, automate onboarding, or execute real deploys.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\customer-onboarding-script-contract test
```
