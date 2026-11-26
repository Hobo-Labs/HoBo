# Container Fallback Wiring Parity Contract — Architecture Evidence

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
input is parsed once at the boundary into derived domain types (`WiringProjection`,
`RuntimeMode`, `ConfigEntry`), and downstream consumers receive those parsed types
instead of re-checking raw env maps. The CUE constraints bound the same derived
types so malformed input is rejected at parse time rather than passed downstream.

## Event Architecture

The conformance report is the read model behind a small event flow:

- **Command** — `deployment.RuntimeModeSwapped` records a component↔container swap.
- **Event** — successful swaps append `deployment.WiringParityAsserted` to the log.
- **Actor** — the manifest IR registry actor applies wiring invariants in order.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — a projection folds the event store into the
  wiring parity report consumers query.
- **Snapshot** — the accepted conformance report is the snapshot of that projection.
- **Read store** — downstream surfaces query that read store rather than the raw
  event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
