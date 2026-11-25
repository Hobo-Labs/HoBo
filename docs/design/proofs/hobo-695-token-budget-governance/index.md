# HOBO-695 Token Budget Governance Proof

This proof backs [governance-planes.md](../../governance-planes.md#per-token-inference-budgets),
[Plan 05](../../reliability-observability-cost.md#plan-05), and
[ADR-0039](../../adr/02-identity-security.md#adr-0039).

The branch adds
[`src/draft/technical-proofs/token-budget-governance-contract`](../../../../src/draft/technical-proofs/token-budget-governance-contract/README.md),
an independent POC for the pre-inference **`TokenBudget`** gate seam. It consumes
a seq-pinned `MeteringView` with inference-token counters, evaluates soft/hard
limits, and emits auditable `policy.Decided` + `inference.BudgetGateEvaluated`
events without building the policy engine, MeteringView projector, or model
runtime.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| `TokenBudget` object with scoped input/output/total soft+hard limits | `soft threshold emits warn obligation without blocking pre-inference gate` |
| Pre-inference gate seam denies before model invocation | `hard threshold denies inference before model invocation` |
| Distinct from auth `token.*` credential events | `inference token budgets are distinct from auth token credential events` |
| Missing metering context fails closed | `missing scoped inference-token counter fails closed` |
| Scope evasion guard | `agent cannot evade cap by splitting spend across sub-scopes` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Hard crossing requires explicit approval when configured | `hard crossing with requireApprovalOnHard routes through approval gate` |
| Agent splits inference across sub-scopes | `agent cannot evade cap by splitting spend across sub-scopes` |
| Missing counter treated as unbounded | `missing scoped inference-token counter fails closed` |

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/token-budget-governance-contract test
```
