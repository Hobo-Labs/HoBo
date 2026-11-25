# Curated Catalog Policy Contract POC

This POC pins HOBO-380: a curated catalog is a trust-tiered, policy-pinned set of
already certified Registry listings. It models curation as `listing.Approved` and
`listing.Revoked` lifecycle events over the listing set, then proves the
prod-only policy rule that `can-deploy` must select only pre-approved listings.

It defines:

- `createCuratedCatalog()` for publishing a named catalog and emitting
  `listing.Approved` for each eligible certified listing.
- `createPreApprovedOnlyProdPolicy()` for a policy-pack rule pinned to one
  catalog.
- `evaluateCatalogSelection()` for the can-deploy hard fail when prod selects a
  listing outside the pinned catalog, a stale policy pin, or a different digest
  under the same listing id.
- `revokeCatalogListing()` for removing a listing from new selection while only
  flagging already deployed Sets.
- `createHostedDefaultCatalog()` for the hosted HoBo default catalog fixture.

Scope intentionally stops before trust-tier composite computation, the full
policy engine, yank lifecycle internals, storefront UX, and provider-backed
Registry storage.

## Verification

Run the focused contract suite:

```powershell
npm.cmd --prefix src\draft\technical-proofs\curated-catalog-policy-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Curated Catalog Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
