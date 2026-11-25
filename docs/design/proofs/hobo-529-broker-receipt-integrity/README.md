---
type: Reference
title: "HOBO-529 Broker Receipt Integrity Proof"
description: "Source issue: HOBO-529."
tags: [hobo, design]
---

# HOBO-529 Broker Receipt Integrity Proof

This proof backs the M3 receipt-integrity hardening evidence for
[Meta-cloud Broker](../../meta-cloud-broker.md).

## Branch Evidence

- Issue: HOBO-529
- Draft package:
  [`src/draft/technical-proofs/broker-receipt-integrity-contract`](../../../../src/draft/technical-proofs/broker-receipt-integrity-contract/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\technical-proofs\broker-receipt-integrity-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Tampered, replayed, downgraded, expired, and cross-environment receipts are rejected. | Focused tests assert stable refusal codes for tamper, replay, downgrade, expiration, tenant mismatch, environment mismatch, broker snapshot mismatch, and manifest mismatch. |
| Valid receipt fixtures remain accepted. | `buildSignedResolutionReceiptFixture` plus `verifyResolutionReceipt` accept the current Ed25519-signed fixture. |
| Failure reasons are precise and do not leak secrets. | Rejection results expose support-safe receipt metadata and reason codes only; tests assert no key material, signature, partial receipt, or handoff object leaks. |

## Adversarial Coverage

The executable proof rejects receipt reuse across tenant, environment, broker snapshot, or manifest
digest. It also keeps Gatekeeper as a downstream apply-time policy boundary and rejects receipts
that try to move Gatekeeper authority inside receipt integrity.

## Scope Boundaries

This package does not implement production key management, hosted broker operations, live broker
persistence, Yard planner behavior, provider adapters, or Gatekeeper policy execution.
