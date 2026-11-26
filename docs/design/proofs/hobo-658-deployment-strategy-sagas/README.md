---
type: Reference
title: "HOBO-658 Deployment Strategy Saga Orchestrator Proof"
description: "Proof record for S6-03 per-service deployment strategy sagas draft POC"
tags: [hobo, design, proof]
---

# HOBO-658 Deployment Strategy Saga Orchestrator Proof

Executable POC:
[`src/draft/epic-proofs/deployment-strategy-saga-orchestrator`](../../../../src/draft/epic-proofs/deployment-strategy-saga-orchestrator/README.md)

## Acceptance mapping

| Acceptance | Evidence |
|---|---|
| Per-service strategy selection (recreate/blue-green/canary/progressive) | `selects recreate, blue-green, canary, and progressive templates per service` |
| Each strategy deploys multi-cloud-shop reference app green | `deploys multi-cloud-shop reference app green for every strategy in CI` |
| Seeded canary regression auto-rolls back event-sourced | `auto-rolls back seeded canary regression on multi-cloud-shop with event-sourced decision` |
| Health-gated promotion from data-plane + provider signals | `health-gates promotion from data-plane and provider health signals` |
| Golden-suite failure adversarial guard | `rolls back on golden-suite failure adversarial case` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Provider health unhealthy | `health-gates promotion from data-plane and provider health signals` (rolled-back) |
| Golden-suite failure | `rolls back on golden-suite failure adversarial case` |
| Seeded canary SLO burn regression | `auto-rolls back seeded canary regression on multi-cloud-shop with event-sourced decision` |

## Verify

```bash
pnpm --prefix src/draft/epic-proofs/deployment-strategy-saga-orchestrator test
```

## Maintenance Note

2026-07-02: Draft POC on branch `cursor/hobo-658-hobo-agent-workflow-d6d4`; S6-01 M0 acceptance
record (HOBO-656) merged — production promotion to `packages/cloud/src/orchestrator/` remains
follow-up per stage-6 acceptance scope.
