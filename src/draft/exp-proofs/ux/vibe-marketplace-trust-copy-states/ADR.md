# ADR: Marketplace Trust Copy States Stay Evidence Routed

Status: Accepted for HOBO-547 branch proof

## Context

Marketplace UX needs copy states for preview warnings, installable listings,
org-catalog policy blocks, deprecated listings, yanked listings, and hidden
listings. The copy must be useful to app developers, workspace administrators,
marketplace operators, security reviewers, and support operators without implying
that Marketplace UX owns approval runtime, policy enforcement, scanner output,
support queues, registry storage, publisher portal UI, or production launch claims.

## Decision

HOBO-547 records copy states as parsed evidence fixtures, not product UI. Each
fixture must name:

- a branch-sized scenario id;
- listing state and user path;
- proof-mode label (`reference-fixture`, `simulated`, `live`, or `scope-out`);
- accepted HOBO-577 quickstart fixture ids and proof-mode labels;
- owner route and evidence source;
- customer-safe copy;
- complete accessibility notes.

Unsafe wording is rejected before it can become a parsed proof. The classifier
refuses security, popularity, installability, registry-guarantee, and
support-readiness overclaims.

The parsed record also pins `rlq-collect-manifest-ir-v1`,
`rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`,
`rlq-manage-stale-evidence-v1`, and `rlq-recover-scope-out-v1` from HOBO-577.
These references keep preview, policy-block, installable, deprecated, yanked,
and hidden-listing copy downstream of accepted quickstart evidence instead of
letting marketplace wording invent runtime behavior.

The package applies parse, don't validate discipline: unknown proof input is
parsed once into the `ParsedMarketplaceTrustCopyStates` derived domain type, and
downstream consumers receive parsed types instead of re-checking raw DTO values.
The protobuf messages and local CUE constraints describe the same boundary shape.

Event architecture remains design-time only for this POC. A later implementation
would accept a `MarketplaceTrustCopyStatesSubmitted` command, emit
`MarketplaceTrustCopyStatesAccepted` or `MarketplaceTrustCopyStatesRejected`
events, and let a `MarketplaceTrustCopyStateActor` append those events to a
marketplace evidence event-store. A `MarketplaceTrustCopyProjection` would build
a materialized view for listing-state copy, record snapshots for branch evidence,
and publish a marketplace trust copy read store for downstream UI and support
handoff consumers. HOBO-547 only names those command/event, actor, event-store,
projection, snapshot, and read store boundaries; it does not implement runtime
CQRS infrastructure.

## Consequences

Downstream marketplace screens can consume these states only as evidence-backed
copy contracts. They still need separate implementation, accessibility review,
policy integration, support tooling, and launch-claim approval before public UI
or launch messaging can depend on them.

The package keeps the boundary executable with TypeScript parser tests,
protobuf shape, local CUE constraints, and a Pact-style mocked response fixture.
