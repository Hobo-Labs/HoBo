---
type: Reference
title: "HOBO-514 DX SDK Resilience Scope Proof"
description: "Source issue: HOBO-514."
tags: [hobo, design]
---

# HOBO-514 DX SDK Resilience Scope Proof

This proof records why HOBO-514 is being treated as branch-sized concrete
blocker work despite the `epic` label. The issue has a scoped M0 acceptance
surface: preserve the SDK-facing resilience vocabulary, child issue matrix,
initiative links, and adversarial guardrails before downstream helper,
conformance, lifecycle, supervision, and diagnostic work continues.

## Requirements Source

- Linear: HOBO-514
- Design record: [DX SDK resilience semantics](../../dx-sdk-resilience-semantics.md)
- SDK contract map: [SDK contracts](../../sdk-contracts.md)
- Proof package: [`dx-sdk-resilience-scope-contract`](../../../../src/draft/exp-proofs/dx/dx-sdk-resilience-scope-contract/README.md)

## Acceptance Evidence

- Child issues HOBO-515, HOBO-516, HOBO-517, HOBO-518, HOBO-519, and HOBO-520
  span M0 through M4 and each has target files, scope-in, scope-out,
  acceptance, adversarial checks, and verification commands.
- The DX SDK resilience project is linked to Testing, Verification & Launch
  Quality; Developer Authoring & Agent Entry Points; and HoBo v1 Release
  Readiness.
- The design record remains discoverable from the design index and SDK contract
  map.
- Adversarial checks reject retrying denial, hidden cancellation retry,
  deadline escalation from non-persisted state, process-memory inspection, and
  golden-IR-only semantics claims.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\dx-sdk-resilience-scope-contract test
npm.cmd run docs:design-lint
node scripts\validate-sdk-contracts.mjs
git diff --check
```
