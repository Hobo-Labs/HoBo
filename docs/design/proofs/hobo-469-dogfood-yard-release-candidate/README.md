---
type: Reference
title: "HOBO-469 Dogfood Yard Release Candidate Proof"
description: "Source issue: HOBO-469."
tags: [hobo, design]
---

# HOBO-469 Dogfood Yard Release-Candidate Proof

HOBO-469 is proven by the focused M3 contract at
[`src/draft/exp-proofs/dx/dogfood-yard-release-candidate-contract`](../../../../src/draft/exp-proofs/dx/dogfood-yard-release-candidate-contract/README.md)
and the durable source record at [dogfood-yard.md](../../dogfood-yard.md#release-candidate-evidence-gate).

## Acceptance Evidence

- Required release-candidate evidence is listed and mapped to owning projects.
- Blockers and accepted risks are recorded with source evidence, owner, mitigation, and launch-risk
  effect.
- Cross-project dependencies map into release cutline domains for operations-readiness,
  documentation, support, and reliability.
- Follow-up execution work is allowed only for missing evidence; the GA hosted-operations handoff
  gap points to existing HOBO-476.
- Parent initiative sync is required when launch risk changes; no update is required while this gate
  records unchanged release-candidate risk.

## Negative Coverage

- Runtime, live-provider, customer-data, and GA/public-claim creep is rejected.
- Speculative follow-ups against accepted evidence are rejected.
- Launch-risk changes without a status update source are rejected.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\dogfood-yard-release-candidate-contract test
pnpm.cmd run check:relevant -- --base=origin/main
```
