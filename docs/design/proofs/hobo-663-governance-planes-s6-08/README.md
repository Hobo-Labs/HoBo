---
type: Reference
title: "HOBO-663 Governance Planes S6-08 Proof"
description: "Source issue: HOBO-663."
tags: [hobo, design]
---

# HOBO-663 Governance Planes S6-08 Proof

Stage-6 governance evidence for [Plan 46](../../governance-planes.md#plan-46) is proven by the
draft epic rollup at
[`src/draft/epic-proofs/governance-planes-s6-08`](../../../../src/draft/epic-proofs/governance-planes-s6-08/README.md).

## Acceptance Mapping

| Stage-6 evidence item | Executable proof |
|---|---|
| Consent-gated notify | `emits event-sourced notification.Requested only when notify consent is granted` |
| Enforced residency obligation | `rejects phi placement outside permitted regions at can-deploy` |
| Crypto-shred erasure | `crypto-shreds subject keys without rewriting prior log events` |
| Blocked flagged model output | `blocks operator agent output when guardrail flags PII in the buffered window` |
| Certified-only Registry install | `installs only certified listings selected by Matching discovery` |
| Composite suite | `passes all four stage-6 governance evidence items in the composite suite` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Notify without consent | `denies notify send without consent and records policy.Decided` |
| Revoked consent bypass | `denies revoked consent instead of bypassing the gate` |
| Guardrail checker error | `fails closed when guardrail checker errors` |
| Uncertified registry install | `never installs uncertified or failed-certification listings` |

## Verification

```bash
pnpm --prefix src/draft/epic-proofs/governance-planes-s6-08 test
```
