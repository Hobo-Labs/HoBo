# ADR: Compose Topology/Status Prototype From Accepted Dashboard Fixtures

## Status

Accepted for HOBO-561 proof work.

## Context

HOBO-561 asks for a topology/status reference prototype over projection
snapshots. The upstream M1 slices already define deployment dashboard mockups
(HOBO-544), freshness/RBAC/support fixtures (HOBO-545), and the canonical
resource-lifecycle quickstart fixture ids (HOBO-577). Recreating those surfaces
here would drift from accepted evidence and risk inventing production behavior.

## Decision

The prototype is a thin composition layer over the accepted M1 proofs and
HOBO-577 quickstart references. It parses both upstream proof exports, pins the
accepted quickstart fixture ids and proof-mode labels, then maps their fixtures
into nine dashboard states: fresh, stale, unavailable, redacted, unauthorized,
partial, failed, rolled-back, and completed. Every state carries source issue,
source fixture, projection source, freshness label, tenant/RBAC disposition,
safe next action, proof mode, and optional redacted support handoff packet.

## Consequences

- Downstream vibe artifacts get one deterministic topology/status shape without
  importing live providers or dashboard runtime.
- Failed and rolled-back states are represented as reference/simulated evidence
  from accepted dashboard and HOBO-577 quickstart records instead of optimistic
  live claims.
- RBAC and support remain fixture dispositions, not enforcement or ticketing
  systems.

## Parse Boundary

The package follows parse, don't validate discipline at the proof boundary.
Unknown input enters `parseVibeTopologyStatusPrototype` once and becomes the
parsed derived type `VibeTopologyStatusPrototype`. Nested constrained values
become derived types such as `TopologyStatusSnapshot`,
`TopologyStatusSupportHandoff`, `TopologyStatusSurface`, and
`TopologyStatusScenario`. Downstream renderers and support packet helpers accept
those parsed types instead of re-checking broad DTOs. The protobuf messages and
CUE constraints bind the same shapes so malformed source dependency, surface,
snapshot, support handoff, scenario, proof-mode, or scope-out evidence is
rejected at parse time.

## Event Architecture

The event architecture is named without implementing runtime infrastructure.
The dashboard consumer command is `RenderTopologyStatusPrototype`. Source events
are `DashboardProjectionRefreshed`, `DashboardProjectionStale`,
`DashboardProjectionUnavailable`, `DashboardProjectionRedacted`,
`DashboardProjectionUnauthorized`, `DashboardProjectionPartial`,
`DeploymentFailed`, `DeploymentRolledBack`, `DeploymentCompleted`, and
`SupportHandoffRouted`. Actors are `DeploymentProjectionActor`,
`RunProjectionActor`, `TopologyProjectionActor`, and `SupportHandoffActor`.
The event-store expectation is replayable projection history from the accepted
fixtures plus HOBO-577 quickstart fixture ids for deploy, inspect, manage stale,
recover, and scope-out paths. Materialized views and projections are the checked
`*View` projection sources. Snapshots are the parsed topology/status records and
their freshness labels. Read store behavior is fixture-only reference reads for
downstream vibe surfaces; this proof does not implement a production read store,
subscription, or GraphQL facade.

## Alternatives Rejected

- Build a small dashboard UI: rejected because HOBO-561 explicitly scopes out
  production dashboard/frontend and graph renderer work.
- Build a read-store or GraphQL facade: rejected because projection runtime
  belongs to later data-plane/runtime slices.
- Copy HOBO-544/545 fixture data wholesale: rejected because direct parsing of
  accepted proof exports gives better drift detection.

## Performance Applicability

Performance is not applicable to this experience proof. The package performs
deterministic in-memory fixture composition only; production query/runtime
latency is out of scope.
