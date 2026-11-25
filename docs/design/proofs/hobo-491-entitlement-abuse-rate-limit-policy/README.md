---
type: Reference
title: "HOBO-491 Entitlement Abuse Rate-Limit Policy Proof"
description: "Source issue: HOBO-491."
tags: [hobo, design]
---

# HOBO-491 Entitlement Abuse Rate-Limit Policy Proof

This proof backs the M0 follow-up policy record for
[Entitlements & Plan Limits](../../entitlements-plan-limits.md).

## Branch Evidence

- Issue: HOBO-491
- Draft package:
  [`src/draft/technical-proofs/entitlement-abuse-rate-limit-policy-contract`](../../../../src/draft/technical-proofs/entitlement-abuse-rate-limit-policy-contract/README.md)
- Focused gate:
  `corepack pnpm --prefix src\draft\technical-proofs\entitlement-abuse-rate-limit-policy-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Policy defines entitlement limit types, rate-limit behavior, grace states, suspension states, appeals, and support overrides. | `ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY` records limit types, response behaviors, customer states, appeal policy, and support overrides; package tests assert the full set. |
| Abuse/fraud responses include audit evidence, customer communication, and recovery path. | The response matrix requires audit evidence, customer-safe communication, and recovery path for runaway usage, rate-limit exceeded, suspected fraud, confirmed abuse, and false-positive correction. |
| Boundaries with billing, tenant quotas, security verification, and support are mapped. | Boundary records route billing/money movement, runtime quota enforcement, security review, and support workflows to owning initiatives. |
| Scope out: no fraud scoring engine selection. | Validation rejects fraud scoring engine selection, risk-model tuning, live runtime enforcement, billing implementation, and support automation creep. |

## Adversarial Coverage

The executable proof rejects scope creep into fraud scoring, runtime rate limiter implementation,
customer suspension automation, payment provider fraud webhooks, chargeback/refund workflows,
support ticket automation, and appeal queue implementation.
