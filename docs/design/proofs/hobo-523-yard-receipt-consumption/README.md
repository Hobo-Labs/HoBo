---
type: Reference
title: "HOBO-523 Yard Receipt Consumption Proof"
description: "Source issue: HOBO-523."
tags: [hobo, design]
---

# HOBO-523 Yard Receipt Consumption Proof

This proof backs the M1 receipt-consumption evidence for
[Meta-cloud Broker](../../meta-cloud-broker.md).

## Branch Evidence

- Issue: HOBO-523
- Draft package:
  [`src/draft/technical-proofs/yard-receipt-consumption-contract`](../../../../src/draft/technical-proofs/yard-receipt-consumption-contract/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\technical-proofs\yard-receipt-consumption-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Receipt fixture is accepted as broker authority input. | `consumeResolutionReceipt` accepts a signed `ResolutionReceipt` fixture and emits a Yard planning input sourced from `resolution-receipt`. |
| Missing, tampered, stale, or incompatible receipt fixtures fail closed. | Focused tests assert `receipt-required:no-broker-reresolve`, `receipt-integrity-failed`, `receipt-stale`, and `receipt-incompatible` refusals. |
| Yard-local planning behavior is documented as receipt consumption, not broker authority. | The planning input records `planningAuthority=yard-control-plane`, `resolutionAuthority=meta-cloud-broker`, and `mayRecomputeBrokerMapping=false`. |

## Adversarial Coverage

- Missing receipt evidence does not invoke a fallback hosted broker resolver.
- Admin controls cannot mutate issued receipt contents; they need a new receipt.
- Gatekeeper can block or add obligations, but cannot rewrite receipt mappings in place.

## Scope Boundaries

This package does not implement the hosted broker runtime, full Yard planner, Matching engine,
provider adapter, admin UI, or Gatekeeper policy engine. It proves the handoff contract that later
runtime and planner issues must honor.
