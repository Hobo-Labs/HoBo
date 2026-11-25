# Supervision Child Lifetime Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how supervision records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's conformance-report boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: raw supervision
facts enter once at the fixture boundary and become parsed, derived domain types
for fixtures, case results, and reports. Downstream validation consumes those
parsed derived types instead of repeatedly checking raw event DTOs.

## Event Architecture

The package's accepted record is a read model behind a small event flow:

- **Command** — a request to run a supervision fixture suite.
- **Event** — each `parent.*`, `child.*`, `retry.*`, `cleanup.*`,
  `workflow.*`, or `inspection.*` fact is a domain event in the ordered log.
- **Actor** — the parent workflow, actor, saga, or runbook aggregate owns child
  lifetime decisions and applies events in order.
- **Event store** — the ordered fact list is the event store the proof replays
  to evaluate supervision cases.
- **Materialized view / projection** — the conformance report projection folds
  event facts into case-result rows and accepted/refused outcomes.
- **Snapshot** — each case result is the snapshot of that projection at the end
  of the fixture.
- **Read store** — later SDK diagnostics read the conformance report snapshots
  rather than trusting in-memory parent or child objects.

No distributed scheduler, process supervision tree, projector, or event store is
implemented here. This is a design-time contract that names the command, event,
actor, projection, snapshot, and read-store boundaries for later implementation.
