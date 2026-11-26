---
type: Reference
title: "HOBO-527 Broker Admin Controls Proof"
description: "Source issue: HOBO-527."
tags: [hobo, design]
---

# HOBO-527 Broker Admin Controls Proof

This proof backs the M2 admin-control boundary for
[Meta-cloud Broker](../../meta-cloud-broker.md).

## Branch Evidence

- Issue: HOBO-527
- Draft package:
  [`src/draft/technical-proofs/broker-admin-controls-contract`](../../../../src/draft/technical-proofs/broker-admin-controls-contract/README.md)
- Workspace metadata:
  `pnpm-lock.yaml` includes the package-local importer; no repository-wide data-model catalog is
  regenerated for this proof.
- Focused gate:
  `pnpm.cmd --prefix src\draft\technical-proofs\broker-admin-controls-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Admin proposal and approval fixtures produce auditable broker environment state transitions. | `applyBrokerAdminAction` records proposal events and approved Broker Environment snapshots with audit evidence. |
| Receipt mutation is impossible through admin controls. | `mutate-receipt` actions fail closed with `admin-controls-cannot-mutate-issued-receipts` and preserve issued receipt refs. |
| Unsupported or unauthorized admin actions fail closed. | Unsupported action kinds and non-admin approval actors return explicit denial reasons without changing state. |

## Adversarial Coverage

The executable proof rejects malformed command IDs, cross-environment approval attempts,
self-approval, post-receipt mutation, and approval without audit evidence. It also classifies full
Admin Console navigation, hosted broker runtime, Yard planner, and Gatekeeper work as out of scope
for this POC.

## Contract Evidence

- Protobuf shapes pin proposal, snapshot, receipt ref, action, event, and state messages.
- CUE constraints require non-empty identifiers, immutable receipt refs, and audit evidence.
- Pact fixture records proposal, approval, receipt-mutation refusal, and missing-audit refusal at
  the Admin Console to Meta-cloud Broker admin boundary.
- Architecture note names parsed domain types, command/event/actor flow, event store, projection,
  snapshot, and read-store boundaries.
