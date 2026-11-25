# Architecture Evidence

This package follows parse, don't validate. Raw fixture data crosses the single
`parseControlPlaneApiResourceLifecycleProof` boundary and becomes the parsed
derived type `ControlPlaneApiResourceLifecycleShapes`.

## Event Architecture

The proof names the command families that later production code will handle:
plan, apply/up, inspect, logs, import/adopt, migrate, rollback, and support
evidence pack commands. It does not execute those commands.

Actors remain ResourceActors behind the control plane. The API shape only names
their event timelines and never mutates actor state directly.

Event-store behavior is append-only: `deployment.Planned`, `match.Decided`,
`resource.Adopted`, `migration.Planned`, `migration.PhaseApplied`,
`migration.RolledBack`, and support handoff facts are read as immutable events.

Materialized views and projections are read through inspect/log/support
operations. Stale projections fail closed with a typed refusal envelope instead
of pretending current state exists.

Snapshots and read stores are explicit response facts. Rollback and migration
responses name snapshot references, while logs and support evidence read from a
redacted read store.

## Scope Boundary

No production REST server, CLI parser, SDK package, MCP server, live provider,
real credential, persistence layer, dashboard, or customer-data path is created
by this proof.
