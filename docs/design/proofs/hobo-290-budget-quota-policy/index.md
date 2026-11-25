# HOBO-290 Budget/Quota Policy Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-29](../../contracts-policy-flags.md#plan-29), and
[ADR-0039](../../adr/02-identity-security.md#adr-0039).

The branch adds
[`src/draft/technical-proofs/budget-quota-policy-contract`](../../../../src/draft/technical-proofs/budget-quota-policy-contract/README.md),
an independent POC for enforcing Camp/tenant budgets and agent spend caps through
the policy plane. It consumes a seq-pinned `MeteringView`, emits an auditable
`policy.Decided`, and records supporting `spend.*` facts without building the
policy engine, showback UI, spend-velocity circuit breaker, or degradation tiers.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Soft threshold emits warn obligation without blocking | `soft threshold emits a warn obligation without blocking the gate` |
| Hard threshold denies deploy and agent-provision at the gate | `hard threshold denies spend-incurring deployment and agent-provision gates` |
| Agent exceeding `spendCapUsd` triggers approve/deny gate | `agent spendCapUsd routes through approve or deny gate instead of silent spend` |
| Every decision is auditable and ties spend to approver | `every decision is an auditable policy.Decided event tying spend to actor and approver` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Estimate under-budget but actual exceeds | `estimate under budget but actual over budget emits reconciliation obligation` |
| Hard deny strands half-provisioned deploy | `hard deny after partial provisioning carries a compensation obligation` |
| Agent splits spend across sub-budgets | `agent cannot evade cap by splitting spend across sub-budgets` |
| Out-of-order counter update crosses threshold | `out-of-order counter update fails closed instead of regressing a crossed threshold` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\budget-quota-policy-contract test
npm.cmd test
```
