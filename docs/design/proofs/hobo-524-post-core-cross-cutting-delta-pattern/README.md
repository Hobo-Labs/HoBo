---
type: Reference
title: "HOBO-524 Post-Core Cross-Cutting Delta Pattern Proof"
description: "Source issue: HOBO-524."
tags: [hobo, design]
---

# HOBO-524 Post-Core Cross-Cutting Delta Pattern Proof

This proof backs the documentation pattern for post-399 cross-cutting capability deltas.

## Branch Evidence

- Issue: HOBO-524
- Source M0 record: [Meta-cloud Broker](../../meta-cloud-broker.md)
- Draft package:
  [`src/draft/technical-proofs/post-core-cross-cutting-delta-pattern`](../../../../src/draft/technical-proofs/post-core-cross-cutting-delta-pattern/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\technical-proofs\post-core-cross-cutting-delta-pattern test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Design index points to the broker design record. | `docs/design/index.md` includes `meta-cloud-broker.md`; the proof reads and asserts that row. |
| Traceability includes the M0 record once the issue id exists. | `docs/design/traceability.md` maps HOBO-521 to the broker design record and executable M0 proof. |

## Adversarial Coverage

The executable proof rejects patterns that make completed epics mutable catch-alls for new
architecture deltas, and rejects docs-only delta claims without a Linear owner plus executable proof
path.
