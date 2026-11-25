# HOBO-385 Trust Tier Policy Proof

This proof package lives at `src/draft/technical-proofs/trust-tier-policy-contract`.

It covers the HOBO-385 acceptance surface from
[`ADR-0062`](../../adr/07-portability-extensibility.md#adr-0062) and
[`ADR-0075`](../../adr/07-portability-extensibility.md#adr-0075):

- `trustTier(listing)` deterministically derives advisory trust from provenance,
  publisher identity, and ratings facts.
- `require.minTier` policy denies below-tier listings and passes listings at or
  above threshold during `can-deploy`.
- The hardened production profile ships a default-on
  `deny-ceiling:prod-min-provenance-tier` policy.
- Disabling the production deny ceiling is explicit and emits an audit fact.
- The composite excludes commercial and price fields.

Negative coverage proves high ratings cannot substitute for low provenance and
unverified publisher identity caps the tier even with strong provenance.

Scope kept out: monetization tiers, ratings ingestion/UI, curated catalog
selection, and any runtime portability escape-hatch behavior.
