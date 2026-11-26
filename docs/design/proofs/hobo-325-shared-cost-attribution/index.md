# HOBO-325 Shared Cost Attribution Proof

This executable proof hardens [PLAN-05](../../reliability-observability-cost.md#plan-05)
and [ADR-0039](../../adr/02-identity-security.md#adr-0039) where shared cheap
variants must not double-count, leak tenant cost, or leave platform-owned
overhead unattributed.

The proof package is
[`src/draft/technical-proofs/shared-cost-attribution-contract`](../../../../src/draft/technical-proofs/shared-cost-attribution-contract/README.md).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Shared DB serving 3 tenants splits cost so three shares sum exactly to total. | `splits a shared database across three tenants without double-counting or remainder` |
| Tenant A showback never contains tenant B cost. | `filters tenant showback so one tenant never sees another tenant cost or identity` |
| Usage-weighted split matches recorded per-consumer usage. | `matches usage-weighted split to recorded per-consumer usage facts` |
| Split replays deterministically from log. | `replays deterministically from out-of-order logs and ignores duplicate usage facts` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Zero recorded usage consumer. | `gives zero-usage consumers fixed overhead only, not variable usage share` |
| Out-of-order usage events. | `replays deterministically from out-of-order logs and ignores duplicate usage facts` |
| Tenant churn inflates share denominator. | `canonicalizes consumer denominator so tenant churn cannot dilute others` |
| Rounding loses or duplicates a cent. | `reconciles rounding so cents are neither lost nor duplicated` |
| Resource owner principal is platform itself. | `keeps platform-owned overhead in the system bucket when no consumer facts exist` |
| Event-sourced auditability is missing. | `audits every share back to cost, consumer, and usage facts` |

## Proof Boundaries

This proof does not implement the base `MeteringView` fold, showback UI,
billing, chargeback, subscriptions, or data-plane cross-tenant isolation. It is
the shared-resource attribution layer that HOBO-293 intentionally deferred.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\shared-cost-attribution-contract test
```

Full gate used for this proof:

```powershell
npm.cmd --prefix src\draft\technical-proofs\shared-cost-attribution-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
