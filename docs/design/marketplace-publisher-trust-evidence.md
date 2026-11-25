---
type: Reference
title: "Marketplace Publisher Trust Evidence"
description: "Productization M0 record for HOBO-503: marketplace publisher trust tiers and review evidence."
tags: [hobo, design]
---

# Marketplace Publisher Trust Evidence

Productization M0 record for HOBO-503: marketplace publisher trust tiers and review evidence.

## Goal

Define how v1 describes marketplace and capability publisher trust without overstating
installability. This record owns evidence categories, customer-visible limitations, and handoffs
for publisher review. It does not build review UI or marketplace operations.

## Scope In

- Publisher trust tiers for generated sandbox listings, verified publishers, hosted curated
  listings, and enterprise-private catalog listings.
- Evidence dimensions for publisher identity, signed artifact provenance, conformance,
  security review, deprecation/yank behavior, and customer-visible warning text.
- Handoffs to artifact provenance and retention, Registry distribution, org catalogs, and launch
  support.
- Unsupported marketplace claims routed as blockers or launch limitations.

## Scope Out

- Marketplace review UI, publisher portal UI, storefront, install-flow UX, and support tooling.
- Monetization, paid publisher tiers, revenue sharing, payouts, or commercial marketplace policy.
- Artifact signing, live Registry storage, curated catalog policy enforcement, SBOM/notice
  generation, or security scanner integration.

## Evidence Contract

The executable contract lives in
[`../../src/draft/exp-proofs/cx/marketplace-publisher-trust-evidence-contract`](../../src/draft/exp-proofs/cx/marketplace-publisher-trust-evidence-contract/README.md).
It defines required trust tiers and validates that each tier carries publisher identity, artifact
provenance, conformance, security review, deprecation/yank, customer warning, and handoff evidence.

## Launch Limitations

- Unreviewed third-party capabilities are blocked from v1 installability claims.
- Paid marketplace and payout claims are explicit v1 launch limitations.
- Ratings, usage counts, publisher identity, and signed provenance cannot substitute for security
  review and curation evidence.

## Related Sources

- [ADR-0062 Registry distribution](./adr/07-portability-extensibility.md#adr-0062)
- [ADR-0074 Org governance](./adr/02-identity-security.md#adr-0074)
- [SBOM vulnerability notice evidence](./sbom-vulnerability-notice-evidence.md)
- [Launch messaging claims](./launch-messaging-claims.md)
