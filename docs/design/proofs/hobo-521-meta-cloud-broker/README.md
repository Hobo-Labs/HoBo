---
type: Reference
title: "HOBO-521 Meta-cloud Broker Proof"
description: "Source issue: HOBO-521."
tags: [hobo, design]
---

# HOBO-521 Meta-cloud Broker Proof

This proof backs the M0 productization record for
[Meta-cloud Broker](../../meta-cloud-broker.md).

## Branch Evidence

- Issue: HOBO-521
- Draft package:
  [`src/draft/exp-proofs/api/meta-cloud-broker-scope-contract`](../../../../src/draft/exp-proofs/api/meta-cloud-broker-scope-contract/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\exp-proofs\meta-cloud-broker-scope-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `META_CLOUD_BROKER_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Broker, Yard control plane, UX admin controls, and Gatekeeper boundaries are mapped. | `authorityBoundaries` is asserted for all four required authorities. |
| Core artifact vocabulary is listed with owners and minimum M1 proof expectations. | `artifacts` is asserted for Contract Manifest, Broker Environment, Mapping Contract, Broker Catalog Snapshot, Resolution Receipt, and Resolution Rejection. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Dependency and boundary records are documented in the design record and carried in the executable scope. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues remain blocked until M0 acceptance. | `canCreateBrokerFollowUp` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects scope creep into broker runtime, Yard planner behavior, provider
adapters, admin UI, Gatekeeper implementation, and release-facing broker claims that lack proof mode
and source evidence. It also requires Yard, admin controls, and Gatekeeper to supersede broker
authority only through a new receipt, new rejection, or explicit policy decision.
