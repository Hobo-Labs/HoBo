---
type: Evidence
title: "HOBO-418 Billing & Credits Scope Proof"
description: "Branch proof for the Billing & Credits M0 scope and acceptance record."
tags: [hobo, proof]
---

# HOBO-418 Billing & Credits Scope Proof

This proof covers [HOBO-418](https://linear.app/quickdeploy-ai/issue/HOBO-418/m0-define-billing-and-credits-scope-and-acceptance).

## Evidence

- Design record: [`billing-credits.md`](../../billing-credits.md)
- Executable proof package:
  [`billing-credits-scope-contract`](../../../../src/draft/exp-proofs/cx/billing-credits-scope-contract/README.md)
- Traceability row: [`docs/design/traceability.md`](../../traceability.md)

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\billing-credits-scope-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
npm.cmd run docs:coverage
npm.cmd run docs:freshness
node --import tsx scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```

## Scope Boundary

This proof records scope and acceptance only. It does not implement live checkout, payment-provider
webhooks, invoice rendering, refunds, tax calculation, usage metering, quota enforcement, pricing
pages, or customer contract terms.
