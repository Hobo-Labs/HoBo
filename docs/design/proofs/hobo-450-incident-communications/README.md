---
type: Reference
title: "HOBO-450 Incident Communications Proof"
description: "Source issue: HOBO-450."
tags: [hobo, design]
---

# HOBO-450 Incident Communications Proof

HOBO-450 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/incident-communications-scope-contract`](../../../../src/draft/exp-proofs/cx/incident-communications-scope-contract/README.md)
and the durable scope record at
[incident-communications.md](../../incident-communications.md).

## Acceptance Evidence

- User/business goal and primary personas are explicit.
- Scope in/out and non-goals are recorded.
- Service, UX, security, and support boundaries are mapped.
- Dependencies link launch support escalation, public status page, support SLA/channels, product
  notifications, launch messaging claims, ADR-0045, and ADR-0058.
- Communication surfaces distinguish public status page, named-customer update, support-ticket
  handoff, internal launch room, and release-note limitation owners.
- Incident states and template kinds are explicit and redaction gated.
- M1 proof requirements name boundary, owner, source, and claim.
- Follow-up M1-M4 work is blocked until M0 acceptance.

## Negative Coverage

- Validation rejects live notification dispatch.
- Validation rejects public status page publishing implementation.
- Validation rejects support ticket automation.
- Validation rejects runbook execution or remediation automation.
- Validation rejects contractual SLA promises.
- Validation rejects customer data fields such as `customer_email`.
- Publication gates reject customer-visible updates without accepted evidence, redaction approval,
  customer-data exclusion, and SLA-language exclusion.

## Verification

```powershell
pnpm --prefix src\draft\exp-proofs\incident-communications-scope-contract test
```
