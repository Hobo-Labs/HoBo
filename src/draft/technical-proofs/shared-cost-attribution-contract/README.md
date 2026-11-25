# Shared Cost Attribution Contract POC

Independent POC for HOBO-325. It hardens the ADR-0039 showback boundary for
shared cheap variants such as shared databases, in-cluster stores, and
scale-to-zero pools. It consumes per-consumer usage facts and emits deterministic
cent-level shares before the HOBO-293 showback report consumes them.

## Contract Surface

- `allocateSharedResourceCost(input)` splits one shared resource period into
  tenant/Camp/Bindle shares.
- Split policies are `usage-share`, `equal`, and `weighted`.
- Fixed overhead is allocated separately from variable usage cost, so a
  registered zero-usage consumer can receive only its fixed-overhead share.
- Consumer identity is canonicalized by tenant/Camp/Bindle/app-tenant identity,
  not by run/session metadata, so churn cannot inflate the denominator.
- Every share carries source usage event ids and audit fact ids. Duplicated
  usage facts are ignored by idempotency key and recorded as deduplicated facts.
- `showbackForTenant(allocation, tenantId)` returns only that tenant's shared
  resource shares and omits other tenant identities and costs.

## Scope Boundaries

Included:

- Shared-resource split policy and exact cent reconciliation.
- Tenant-isolated showback rows for shared-resource shares.
- Usage-weighted, equal, and weighted allocation strategies.
- Fixed overhead and platform-owned system-overhead handling.
- Deterministic replay from out-of-order usage logs.
- Audit links from every share to resource-cost, registration, and usage facts.

Excluded:

- The base `MeteringView` fold.
- Dashboard or showback presentation.
- Billing, chargeback, invoicing, or subscriptions.
- Data-plane cross-tenant isolation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\shared-cost-attribution-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Shared Cost Attribution Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
