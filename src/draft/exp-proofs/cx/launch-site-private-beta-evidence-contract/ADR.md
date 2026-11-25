# Launch Site Private Beta Evidence — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how records map onto
the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted private-beta evidence input
is parsed once at the boundary into a derived launch evidence record. Downstream consumers receive
that parsed record instead of broad strings that must be rechecked at every call site. The CUE
constraints bound the same derived types so malformed evidence owners, unlabeled proof modes,
speculative follow-ups, and public-claim promotion are rejected at parse time.

## Event Architecture

The accepted evidence gate is the read model behind a small event flow:

- **Command** — `launchSitePrivateBetaEvidence.RecordRequested` asks the launch messaging owner
  aggregate to record or amend private-beta evidence.
- **Event** — `launchSitePrivateBetaEvidence.RecordAccepted` appends the parsed evidence record,
  required assets, blockers, accepted risks, and cutline sync state.
- **Actor** — the V1 Launch Site, Messaging & Demo Assets proof owner is the aggregate that applies
  accepted record events in order.
- **Event store** — accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** — a projection folds the event store into the private-beta
  launch evidence read model.
- **Snapshot** — the current accepted evidence gate is the projection snapshot used by release
  readiness and launch messaging reviewers.
- **Read store** — downstream surfaces query the read store rather than raw Linear comments or ad
  hoc docs.

No launch site runtime, public copy workflow, screenshot generator, recording service, or hosting
implementation is built here.
