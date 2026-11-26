---
type: Reference
title: "HOBO-422 Publisher Portal M0 Scope Proof"
description: "Source issue: HOBO-422."
tags: [hobo, design]
---

# HOBO-422 Publisher Portal M0 Scope Proof

HOBO-422 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/publisher-portal-scope-contract`](../../../../src/draft/exp-proofs/ux/publisher-portal-scope-contract/README.md)
and the durable scope record at
[publisher-portal.md](../../publisher-portal.md).

## Acceptance Evidence

- User/business goal names Publisher Portal as a Productization M0 scope record.
- Primary personas cover publisher owner, publisher maintainer, marketplace operator, security
  reviewer, support operator, and release owner needs.
- Scope-in lists publisher profile, maintainer roles, submission evidence, review status, payout
  readiness, support wording, and M1-ready proof assets.
- Service, UX, security, and support boundaries state which downstream initiatives consume the
  record without taking their implementation scope.
- Dependencies link marketplace publisher trust, capability review, payout hooks, org catalogs,
  billing launch policy, support escalation, ADR-0062, ADR-0074, and ADR-0064.
- Portal states define draft, identity-pending, evidence-required, review-ready, limited-beta,
  installable, rejected, yanked, payout-blocked, and support-escalated outcomes.
- The follow-up gate blocks M1-M4 work until M0 acceptance is recorded.

## Negative Coverage

- Validation rejects publisher portal UI, React screens, and frontend implementation scope creep.
- Validation rejects review approval service, scanner, conformance runner, and policy enforcement
  scope creep.
- Validation rejects live Registry storage, artifact publish/pull runtime, and trust-badge scope
  creep.
- Validation rejects payout provider, bank account, tax document, revenue-share, or money-movement
  scope creep.
- Validation rejects billing dashboard, invoice, payment-provider, support ticket, and ticket
  automation scope creep.
- Validation rejects customer-visible claims without a proof source and owner route.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\publisher-portal-scope-contract test
```
