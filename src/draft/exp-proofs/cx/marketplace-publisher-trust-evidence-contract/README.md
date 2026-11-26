# Marketplace Publisher Trust Evidence Contract

Independent POC for HOBO-503. It pins the M0 launch evidence contract for marketplace
publisher trust tiers and review evidence without implementing marketplace review UI,
publisher portal flows, monetization, or paid tiers.

## Contract Surface

- `MARKETPLACE_PUBLISHER_TRUST_EVIDENCE` is versioned as
  `hobo.marketplace-publisher-trust-evidence/v1`.
- Trust tiers cover generated sandbox listings, verified publishers, hosted curated listings, and
  enterprise-private catalog listings.
- Required evidence covers publisher identity, artifact provenance, conformance, security review,
  deprecation/yank behavior, and customer-visible warnings.
- Handoffs map each tier to artifact provenance, Registry distribution, org catalogs, and support.
- Unsupported marketplace claims are explicit v1 blockers or launch limitations.

## Scope Boundaries

Included:

- Deterministic M0 evidence fixture and validator.
- Trust-tier evidence dimensions and required handoffs.
- Customer-visible warnings for installability and unsupported claims.
- Negative guards for UI, monetization, and evidence-less install claims.

Excluded:

- Marketplace review UI, publisher portal UI, storefront, paid tiers, payouts, or revenue sharing.
- Live Registry implementation, artifact signing, curated catalog policy enforcement, or support
  tooling.
- Replacing SBOM/notice evidence, trust-tier policy, or curated catalog contracts.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\marketplace-publisher-trust-evidence-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Marketplace Publisher Trust Evidence Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
