# ADR: CLI manage inspect logs drift prototype

## Status

Accepted for `HOBO-574`.

## Context

HOBO-574 needs an M2 transcript prototype for the manage side of the v1 vibe
resource lifecycle. The prototype must consume the accepted M1 fixture and
CLI/MCP parity vocabulary without claiming production observability, live logs,
real support tooling, customer data, or dashboard behavior.

## Decision

Define the manage transcript as an executable experience proof under
`src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype`.

The proof covers six reference fixture states: normal operation, stale
projection, non-reactive sink warning, drift detected, support handoff, and
redacted evidence pack. Each state carries a CLI command, equivalent MCP tool
call, machine result, human terminal transcript, proof mode, fixture sources,
correlation ID, and redaction evidence.

The proof uses parse don't validate: raw transcript records cross
`parseManageTranscriptPrototype`, which returns a branded parsed object only
after issue, package, proof-note, manage-state, fixture-source, proof-mode,
redaction, and CLI/MCP parity invariants hold. Renderers and downstream proof
consumers receive derived parsed types rather than re-checking raw fixture
objects.

## Architecture Notes

- Commands: `hobo inspect`, `hobo logs`, and `hobo doctor` manage reads against
  run inspector, projection, drift, audit, and support evidence fixtures.
- Events: future runtime sources remain ResourceActor histories, projection
  freshness events, drift findings, token/audit events, log cursor events, and
  support bundle events.
- Actors: ResourceActor remains the expected durable owner of resource timeline
  state; this proof only names transcript evidence.
- Event store: accepted events append to the platform event store as the
  replayable source of truth.
- Materialized view / projection: inspect/log/doctor surfaces consume snapshots
  and must label stale or non-reactive evidence instead of treating it as live
  state.
- Snapshot: each transcript scene is a fixture-backed snapshot with explicit
  proof mode and correlation ID.
- Read store: downstream support and automation proof packages read these
  transcript snapshots, not a production read store implementation.
- PACT/Protobuf/CUE: local artifacts define the CLI/MCP transcript boundary so
  later packages can consume stable fixture evidence without inventing parallel
  shapes.

## Consequences

Later dashboard, docs, support, launch, and quickstart artifacts can reuse the
same manage-state copy and JSON schema. Production observability, live log
streaming, real support automation, customer data, and dashboard-first mockups
remain outside this branch-sized proof.
