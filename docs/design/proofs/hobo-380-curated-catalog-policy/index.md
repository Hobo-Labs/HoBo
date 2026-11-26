# HOBO-380 Curated Catalog Policy Proof

This executable proof pins the curated-catalog slice from
[ADR-0062](../../adr/07-portability-extensibility.md#adr-0062) and the
mandatory policy rule behavior from
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Catalog can be defined over fixture listings and `listing.Approved` emitted | `catalog definition emits listing.Approved for fixture certified listings` |
| Under pre-approved-only prod policy, approved listing succeeds and non-approved hard-fails with remediation | `prod pre-approved-only policy allows approved listings and hard-denies others` |
| Policy-pinned catalog selection is bound to the approved digest and policy pin | `prod selection is pinned to catalog policy and approved digest` |
| `listing.Revoked` removes a listing from approved set for new selection | `listing.Revoked removes approvals from new selection without rewriting deployed Sets` |
| Hosted default catalog lets fixture Bindle deploy with no extra approval | `hosted default catalog lets fixture Bindle deploy without extra approval` |

## Adversarial Mapping

| Adversarial case | Guard |
|---|---|
| Approving listing does not bypass signature or conformance verification | `approval cannot bypass signature or conformance verification` |
| Revoke removes from new selection without force-rewriting deployed Sets | `listing.Revoked removes approvals from new selection without rewriting deployed Sets` |
| Catalog tier N cannot vouch for listing below tier N | `catalog tier cannot vouch for a listing below that tier` |

## Boundary

The proof lives in
[`src/draft/technical-proofs/curated-catalog-policy-contract`](../../../../src/draft/technical-proofs/curated-catalog-policy-contract/README.md).
It does not implement trust-tier composite computation, the full policy engine,
yank propagation, Registry persistence, or storefront UX.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\curated-catalog-policy-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
