---
type: Reference
title: "HOBO-657 S6-02 Control-Plane HA Proof"
description: "Source issue: HOBO-657."
tags: [hobo, design]
---

# HOBO-657 S6-02 Control-Plane HA Proof

Executable proof record for control-plane HA hardening (quorum replication, leader election,
actor failover, provider resilience).

## Branch Evidence

- Issue: [HOBO-657](https://linear.app/quickdeploy-ai/issue/HOBO-657)
- Design source: [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- Draft package:
  [`src/draft/technical-proofs/s6-02-control-plane-ha-contract`](../../../../src/draft/technical-proofs/s6-02-control-plane-ha-contract/README.md)
- Focused gate:
  `pnpm --prefix src/draft/technical-proofs/s6-02-control-plane-ha-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Chaos test kills Yard leader mid-deploy; follower resumes within NFR-009 `< 30 s`. | `runLeaderKillMidDeployChaos` + acceptance test |
| No duplicate resource actions; fencing verified. | stale-fence rejection + unique `actionId` assertions |
| 99.9% control-plane availability soak lane. | `runAvailabilitySoak` meets `CONTROL_PLANE_AVAILABILITY_TARGET` |
| Quorum event-store replication + leader election. | quorum minority rejection + leader lease conflict tests |
| Provider circuit breakers, retry budgets, bulkheads. | `evaluateProviderResilience` adversarial trace |

## Adversarial Coverage

- Minority partition cannot commit quorum writes.
- Stale leader fenced append rejected after successor takeover.
- Duplicate resource `actionId` blocked at event store.
- Circuit breaker opens and blocks degraded provider hammering.
- Retry budget exhausts under flapping failures.
- Bulkhead rejects overflow concurrency per tenant.

## Maintenance Note

2026-07-02: Draft POC on branch `cursor/hobo-657-hobo-agent-workflow-4c9e`; S6-01 M0 acceptance
record (HOBO-656) merged — production promotion to `packages/cloud` + `runtime-postgres` remains
follow-up per stage-6 acceptance scope.
