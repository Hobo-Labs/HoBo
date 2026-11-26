# Launch Demo Golden Path — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted launch-demo checklist input
is parsed once at the boundary into a derived golden-path record. Downstream consumers receive that
parsed record instead of broad strings that must be rechecked at every call site. The CUE
constraints bound the same derived types so malformed proof assets, unlabeled proof modes, or
scope-creep commands are rejected at parse time.

## Event Architecture

The accepted checklist is the read model behind a small event flow:

- **Command** — `launchDemoGoldenPath.RecordRequested` asks the owner aggregate to record or amend
  the accepted golden-path checklist.
- **Event** — `launchDemoGoldenPath.RecordAccepted` appends the parsed record and proof-mode
  evidence.
- **Actor** — the Example Apps proof owner is the aggregate that applies accepted record events in
  order.
- **Event store** — accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** — a projection folds the event store into the launch demo
  golden-path read model.
- **Snapshot** — the current accepted checklist is the projection snapshot used by launch messaging
  and demo maintainers.
- **Read store** — downstream surfaces query the read store rather than raw comments or ad hoc docs.

No runtime engine, projector, demo app, or launch site is implemented here. This is a design-time
contract that names the command, event, actor, projection, snapshot, and read-store boundaries so
later implementation inherits a consistent vocabulary.
