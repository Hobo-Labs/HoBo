---
type: Reference
title: "HOBO-659 S6-04 Multi-Region DR Replay Proof"
description: "Source issue: HOBO-659."
tags: [hobo, design]
---

# HOBO-659 S6-04 Multi-Region DR Replay Proof

Executable proof record for multi-region Yard topology, cross-region log replication,
and `hobo yard up --restore <log>` DR-as-replay semantics.

## Branch Evidence

- Issue: [HOBO-659](https://linear.app/quickdeploy-ai/issue/HOBO-659)
- Design source: [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05), [control-plane.md](../../control-plane.md#plan-04)
- Draft package:
  [`src/draft/technical-proofs/multi-region-dr-replay-contract`](../../../../src/draft/technical-proofs/multi-region-dr-replay-contract/README.md)
- Focused gate:
  `pnpm --prefix src/draft/technical-proofs/multi-region-dr-replay-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Multi-region topology (active-passive log + active-active stateless tier). | `parseMultiRegionTopology` + topology parse test |
| Cross-region log replication with honest RPO reporting (≤ 5 s async tier). | `assessCrossRegionReplication` + lag honesty test |
| `hobo yard up --restore <log>` replays streams and rehydrates actors/projections. | `yardUpRestore` + restore argv/rehydration test |
| Region-loss drill: RTO < 15 min, RPO ≤ 5 s, byte-identical projections (NFR-008). | `runRegionLossDrill` + drill scenario test |
| Adversarial guards for RPO lag, RTO breach, hash mismatch, corrupt log. | adversarial test suite |

## Adversarial Coverage

- Async replica lag beyond 5 s RPO budget fails restore.
- RTO exceeding 15 minute target fails region-loss drill.
- Projection hash mismatch fails integrity check.
- Empty or corrupt replicated logs rejected at parse boundary.

## Maintenance Note

2026-07-02: Draft POC on branch `cursor/hobo-659-hobo-agent-workflow-b31e`; blocker HOBO-657 (S6-02)
Done via PR #717 — production promotion to `packages/cloud` remains follow-up per stage-6 acceptance scope.
