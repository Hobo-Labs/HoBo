---
type: Reference
title: "HOBO-528 Meta-cloud Broker Rejection Matrix Proof"
description: "Source issue: HOBO-528."
tags: [hobo, design]
---

# HOBO-528 Meta-cloud Broker Rejection Matrix Proof

HOBO-528 is proven by the focused M3 contract at
[`src/draft/exp-proofs/api/meta-cloud-broker-rejection-matrix-contract`](../../../../src/draft/exp-proofs/api/meta-cloud-broker-rejection-matrix-contract/README.md)
and the durable boundary record at [meta-cloud-broker.md](../../meta-cloud-broker.md).

## Acceptance Evidence

- Stale catalog, incompatible mapping, ambiguous mapping, missing mapping, and unsupported
  capability fixtures each emit their expected structured reason code.
- Rejections are signed `hobo.resolution-rejection/v1` outputs and never emit partial receipts,
  resource plans, optimistic Yard plans, or unsigned evidence.
- Support/debug evidence preserves replay digests and evidence IDs while excluding raw secrets,
  tokens, and customer payloads.

## Negative Coverage

- Ambiguous best-effort selection is rejected as `mapping.ambiguous`.
- Stale catalog optimism is rejected as `catalog.stale`.
- Hidden provider-default fallback is rejected as `mapping.missing`.
- Hidden Yard-local planning is rejected as `capability.unsupported`.

## Verification

```powershell
pnpm.cmd --prefix src\draft\meta-cloud-broker-rejection-matrix-contract test
```
