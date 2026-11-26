# ADR: Marketplace Discovery Prototype Composes Accepted M1 Fixtures

## Status

Accepted for HOBO-562 proof work.

## Context

The M2 marketplace discovery slice must show approved, preview, limited-beta, policy-blocked,
deprecated, and yanked listing paths without inventing product behavior beyond the accepted M1
marketplace mockup and trust-copy proofs. It also has to preserve HOBO-577 quickstart proof-mode
labels so later docs, tutorials, support, and launch-demo consumers can cite deterministic evidence.

## Decision

Model the discovery prototype as a parsed fixture catalog. Each visible listing state carries a
source HOBO-546 mockup fixture, source HOBO-547 trust-copy fixture, HOBO-577 quickstart ref,
org-catalog decision, support route, installability outcome, proof mode, customer-safe message, and
safe next action. The parser validates source issue identity and fixture-id existence before
returning a branded object.

CUE constraints bound every protobuf type in that schema: the prototype record, source issue,
mockup source, trust-copy source, quickstart ref, catalog fixture, and path records all have local
CUE counterparts in `architecture/vibe_marketplace_discovery_prototype.cue`.

The package applies Parse, don't validate discipline at the fixture boundary. Unknown JSON enters
`parseMarketplaceDiscoveryPrototype` once and becomes the parsed derived type
`ParsedMarketplaceDiscoveryPrototype`; downstream summary rendering accepts
`MarketplaceDiscoveryCatalogFixture` from that parsed proof instead of re-checking broad DTO values.

The event architecture is named without implementing runtime services. The consumer command is
`RenderMarketplaceDiscoveryPrototype`; source events are `MarketplaceListingDiscovered`,
`MarketplaceInstallIntentEvaluated`, `MarketplaceCatalogDecisionExplained`,
`MarketplaceTrustCopyApplied`, `MarketplaceSupportRouteShown`, and
`MarketplaceScopeOutRejected`; actors are `MarketplaceUxActor`, `OrgCatalogActor`,
`CapabilityReviewActor`, `RegistryDistributionActor`, and `SupportHandoffActor`; the event store
expectation is deterministic fixture replay from HOBO-546, HOBO-547, and HOBO-577 source fixtures;
materialized views/projections are discovery catalog, install-intent, blocked-listing, stale
evidence, and support-handoff views; snapshots are the parsed catalog fixtures; read-store behavior
is fixture-only reference reads.
In runtime terms, the command emits events through actors into an event store, the materialized
views and projections are rebuilt from fixture replay, snapshots are the parsed catalog records, and
the read store is a deterministic fixture read store.

## Consequences

- Downstream marketplace UX can render discovery/install-intent examples from one deterministic
  fixture surface instead of copying M1 records.
- Scope expansion into live storefronts, registry resolution, install runtime, ranking,
  monetization, publisher workflow, production UI, support queues, or unsupported launch claims is
  rejected by tests.
- This proof remains an experience proof; production marketplace implementation and services remain
  out of scope.
