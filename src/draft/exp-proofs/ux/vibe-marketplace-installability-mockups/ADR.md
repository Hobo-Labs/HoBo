# ADR: HOBO-546 Marketplace Installability Mockup Scope

## Status

Accepted for proof package.

## Context

Marketplace UX consumers need browse, search, listing-detail, and installability mockups before production marketplace services exist. The mockups must reuse HOBO-577 quickstart fixture ids and the accepted Marketplace UX M0 vocabulary instead of inventing install behavior or implying a live storefront.

## Decision

HOBO-546 models marketplace installability as local reference fixtures backed by protobuf, CUE, and Pact-style artifacts. The required listing states are:

- preview-only,
- limited-beta,
- installable,
- policy-blocked,
- deprecated,
- yanked.

Every listing fixture carries visible state, evidence source, owner route, customer-safe message, org-catalog disposition, proof mode, trust evidence, and support handoff. The parser fails closed when any acceptance field is removed or when scenario paths point at unknown fixtures.

The package applies Parse, don't validate discipline at the fixture boundary. Unknown JSON enters `parseVibeMarketplaceInstallabilityMockups` once and becomes parsed types such as `ParsedVibeMarketplaceInstallabilityMockups` and `MarketplaceListingFixture`; summary rendering accepts parsed fixture types rather than raw DTOs.

The event architecture is named without implementing a runtime. The consumer command is `RenderMarketplaceInstallabilityMockups`; source events are `MarketplaceListingStatePresented`, `MarketplaceInstallabilityEvidenceAttached`, `MarketplacePolicyBlockExplained`, `MarketplaceDeprecationGuidanceShown`, and `MarketplaceYankSupportRouted`; the owning actors are `MarketplaceUxActor`, `CapabilityReviewActor`, `OrgCatalogActor`, `RegistryDistributionActor`, and `SupportHandoffActor`; the event store expectation is deterministic fixture replay from HOBO-577 quickstart ids; projections are browse, search, detail, and installability materialized views; snapshots are the listing fixtures; read store behavior is fixture-only reference reads.

## Consequences

Downstream marketplace prototype work can consume precise state, evidence, owner, and support wording without importing unmerged production code. Future implementation issues must replace the fixture provider with real marketplace, registry, catalog, policy, and support integrations under their own contracts.
