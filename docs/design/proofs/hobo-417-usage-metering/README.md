---
type: Reference
title: "HOBO-417 Usage Metering M0 Proof"
description: "Source issue: HOBO-417."
tags: [hobo, design]
---

# HOBO-417 Usage Metering M0 Proof

This proof package demonstrates that HOBO-417 records accepted M0 scope before follow-up Usage
Metering design/build work can fan out.

## Evidence

- Design record:
  [`docs/design/usage-metering.md`](../../usage-metering.md)
- Executable contract:
  [`src/draft/exp-proofs/cx/usage-metering-scope-contract`](../../../../src/draft/exp-proofs/cx/usage-metering-scope-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
npm.cmd --prefix src\draft\exp-proofs\usage-metering-scope-contract test
```

The check proves the HOBO-417 acceptance bullets and adversarial boundaries:

- explicit user/business goal and primary personas;
- recorded scope in/out, non-goals, and service/UX/security/support boundaries;
- mapped dependencies to cost, data-plane, billing, tax, showback, and credit-ledger sources;
- owning initiative dependencies and handoff boundaries;
- evidence required for M1 design and contract proof;
- follow-up gate preventing M1-M4 issue creation before M0 acceptance;
- rejected scope creep into invoice/payment, entitlement, Dispatcher/CreditLedger, provider sync,
  tax, or live customer usage work.
