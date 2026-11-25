---
type: Reference
title: "HOBO-526 Broker Environment Publication Proof"
description: "Source issue: HOBO-526."
tags: [hobo, design]
---

# HOBO-526 Broker Environment Publication Proof

This proof backs the M2 provider/catalog mapping publication evidence for
[Meta-cloud Broker](../../meta-cloud-broker.md).

## Branch Evidence

- Issue: HOBO-526
- Draft package:
  [`src/draft/technical-proofs/broker-environment-publication-contract`](../../../../src/draft/technical-proofs/broker-environment-publication-contract/README.md)
- Focused gate:
  `pnpm --prefix src\draft\broker-environment-publication-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Snapshot fixture includes provider capability, mapping, approval, version, and provenance evidence. | `publishBrokerEnvironmentSnapshot(...)` emits a frozen `hobo.broker-environment-snapshot/v1` fixture carrying provider capability digest, conformance digest, mapping digest, approval id, publication/catalog version, provenance digest, and source refs. |
| Unapproved, stale, or incompatible mapping publications fail closed. | Focused tests assert pending approval, stale catalog snapshot, and incompatible mapping inputs return structured errors instead of a snapshot. |
| Broker Environment snapshots are immutable inputs to resolution proof. | `createResolutionProofInput(...)` consumes only the frozen snapshot id and provider-default input ids, with no final Yard decision field. |

## Adversarial Coverage

- Provider claims without conformance evidence are rejected.
- Approval records without evidence are rejected.
- Shadow updates that change resolution-affecting input while reusing a snapshot id are rejected.
- Provider defaults remain broker validation inputs and cannot masquerade as final Yard placement.

## Scope Boundaries

This package does not implement provider adapters, marketplace publishing UX, hosted broker runtime,
Yard planner behavior, or live catalog sync. It proves the publication fixture and immutable
snapshot boundary that later broker resolution work must honor.
