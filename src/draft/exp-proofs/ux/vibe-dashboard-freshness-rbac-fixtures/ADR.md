# ADR: HOBO-545 Dashboard Fixture Scope

## Status

Accepted for proof package.

## Context

Deployment Dashboard & Topology Explorer consumers need deterministic examples for read projection freshness, tenant/RBAC visibility, and support handoff wording before any production dashboard, read store, authorization, or redaction runtime exists.

## Decision

HOBO-545 models these states as local reference fixtures backed by protobuf, CUE, and Pact-style artifacts:

- fresh,
- stale,
- unavailable,
- redacted,
- unauthorized,
- partial,
- support-routed.

Every fixture carries tenant-first scope, RBAC role, projection source, owner actor, redaction evidence, customer-safe wording, and next action. The parser fails closed when tenant-first scope or withheld redaction evidence is removed.

The proof also names the required happy, blocked, stale/unknown evidence, and support handoff coverage paths. Each path links back to fixture ids, accessibility guidance, safe outcome wording, and one or more proof-mode labels from `live`, `simulated`, `reference fixture`, and `scope-out`; current fixture bodies remain `reference fixture` evidence so consumers cannot infer production readiness.

The package applies parse don't validate discipline at the fixture boundary. Unknown JSON enters `parseDashboardFreshnessRbacFixtures` once and becomes parsed derived types: `DashboardFreshnessRbacFixtureProof`, `DashboardReadStateFixture`, `DashboardFixtureScope`, `DashboardFixtureOwner`, `DashboardFixtureFreshness`, and `DashboardFixtureRedaction`. Downstream summary and support handoff rendering accepts those parsed types instead of re-checking raw DTOs.

The event architecture is named even though this proof does not implement a runtime. The dashboard consumer command is `RenderDashboardProjectionFixtures`; source events are `DashboardProjectionRefreshed`, `DashboardProjectionStale`, `DashboardProjectionUnavailable`, `DashboardProjectionRedacted`, `DashboardProjectionUnauthorized`, `DashboardProjectionPartial`, and `SupportHandoffRouted`; actors are the projection actors named in each fixture; the event-store expectation is replayable dashboard projection history; materialized views and projections are the `*View` projection sources; snapshots are the fixture freshness records; and read store behavior is fixture-only reference reads with no production read-store implementation.

## Consequences

Dashboard, docs, and support proof consumers can exercise the states without importing unmerged runtime code or claiming production readiness. Future implementation issues must replace the fixture provider with real projection, auth, redaction, and support integrations under their own contracts.
