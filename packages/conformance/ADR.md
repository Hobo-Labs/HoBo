# @hobo/conformance Port Suite Harness — Architecture Evidence

This production package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`contracts/`](./contracts) records the CI-gate consumer
  boundary on the port-suite report envelope.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted suite
definitions and adapter registrations cross exactly one parser boundary
(`createConformanceSuite`, `createAdapterRegistry`), and downstream consumers
receive parsed, derived types instead of re-checking raw input. The CUE
constraints bound the same derived types so malformed input is rejected at parse
time rather than passed downstream.

## Event Architecture

The port-suite report is a **materialized view** derived from an append-only
conformance run event log:

- **Command** — `runConformanceSuite` requests a conformance evaluation for an
  adapter against a port suite.
- **Event** — the runner appends `conformance.RunStarted`,
  `conformance.CaseChecked`, `conformance.CoverageEvaluated`, and
  `conformance.RunCompleted` events to an immutable in-memory log.
- **Actor** — the conformance runner is the actor that appends events in order.
- **Event store** — the in-memory `ConformanceRunEvent` log is the durable source
  of truth for a single run.
- **Materialized view / projection** — `projectPortSuiteReport` folds the event
  log into the `PortSuiteReport` read model.
- **Snapshot** — the `PortSuiteReport` is the snapshot of that projection.
- **Read store** — CI and Registry consumers query the report snapshot rather
  than re-deriving checks from raw adapter output.

Replaying `report.events` through the projector reproduces the report
byte-for-byte.
