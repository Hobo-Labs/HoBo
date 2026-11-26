# ADR: First-run activation rail stays fixture-backed

## Status

Accepted for `HOBO-540`.

## Context

Workspace & Onboarding UX needs a first-run rail that helps app developers, team admins, platform
engineers, and support operators understand what is ready, blocked, stale, or handed off. The rail
must reuse the canonical resource lifecycle quickstart fixtures from `HOBO-577`; otherwise
downstream workspace mockups could invent behavior before the API, SDK, CLI, and MCP contracts exist.

## Decision

Represent the rail as an experience proof package with:

- persona wireframe records rather than production UI;
- a typed state model for invite or try-it, workspace, project, plan preview, launch attempt,
  recovery, and value proof;
- evidence object names and owner routes for every stage;
- proof-mode labels for live, simulated, reference fixture, and scope-out states;
- protobuf, CUE, and Pact-style fixture evidence aligned with the TypeScript parser.

The live proof mode is only a gated future handoff label. It does not authorize live provider calls,
credentials, customer data, or launch claims.

The event architecture is intentionally named but not built here. Future commands such as
`activation.SelectOutcome` and `activation.OpenSupportHandoff` emit activation events owned by an
onboarding actor and stored in an activation event-store. The query side reads materialized views
and projections from persisted snapshots in a read store. This package only proves those labels and
handoff boundaries with fixtures.

## Consequences

Downstream Workspace UX, plan/diff, dashboard, support, docs, and launch artifacts get a stable
fixture-backed rail to consume. Production UI, runtime onboarding, telemetry collection, live cloud
execution, and support tooling remain outside this slice.
