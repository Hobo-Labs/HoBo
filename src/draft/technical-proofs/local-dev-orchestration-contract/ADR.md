# Local Dev Orchestration Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted manifest
input is parsed once at the boundary into derived domain types, and downstream
consumers receive those parsed, derived types instead of re-checking raw input.
The CUE constraints bound the same derived types so malformed input is rejected
at parse time rather than passed downstream.

## Event Architecture

The package's local lifecycle is a small event flow:

- **Command** — `hobo dev` session start / manual `hobo dev start <resource>`.
- **Event** — lifecycle transitions recorded as orchestration events.
- **Actor** — per-resource local orchestrator state keyed by resource id.
- **Event store** — accepted events are appended to the session event log as the
  durable source of truth for replay.
- **Materialized view / projection** — `activationLog` and `state` fold the event
  log into caller-visible snapshots.
- **Snapshot** — each returned `state` object is the snapshot of that projection.
- **Read store** — downstream surfaces query that read store rather than the raw
  event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract naming the command, event, actor, and projection boundaries
for HOBO-694.
