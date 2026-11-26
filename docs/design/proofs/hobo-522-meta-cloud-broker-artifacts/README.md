---
type: Reference
title: "HOBO-522 Meta-cloud Broker Artifact Proof"
description: "Source issue: HOBO-522."
tags: [hobo, design]
---

# HOBO-522 Meta-cloud Broker Artifact Proof

This proof backs the M1 artifact schema and validation contract for
[Meta-cloud Broker](../../meta-cloud-broker.md).

## Branch Evidence

- Issue: HOBO-522
- Draft package:
  [`src/draft/technical-proofs/meta-cloud-broker-artifact-contract`](../../../../src/draft/technical-proofs/meta-cloud-broker-artifact-contract/README.md)
- Focused gate:
  `pnpm.cmd --prefix src\draft\technical-proofs\meta-cloud-broker-artifact-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Artifact schemas and golden fixtures exist. | `BROKER_ARTIFACT_SCHEMAS`, `schema/meta-cloud-broker-artifacts.v1.schema.json`, protobuf, CUE, and focused tests cover all six artifacts. |
| Validation distinguishes accepted receipts from structured rejections. | `evaluateBrokerArtifacts` emits deterministic `resolution-receipt` and `resolution-rejection` fixtures from parsed artifact sets. |
| Each artifact names owner, version, and minimum provenance fields. | `parseBrokerArtifactSet` requires owner, semantic version, source issue, proof mode, and signature digest on every artifact envelope. |
| Contract proof is deterministic and can run in CI. | The package test compares repeat evaluation digests and runs without live services. |

## Adversarial Coverage

The executable proof rejects unsigned, unversioned, ownerless, ambiguous-mapping, and
Gatekeeper-policy-masquerade artifacts before receipt/rejection evaluation.

## Scope Boundary

The proof does not implement hosted broker runtime behavior, Yard planner behavior, provider
adapters, admin UI, or Gatekeeper policy execution.
