# Vibe Plan Review States — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies **parse, don't validate**: untrusted plan review fixture
records cross one parser boundary and become `ParsedVibePlanReviewStates`.
Downstream proof consumers receive the parsed type instead of raw DTOs plus
repeated boolean checks. CUE constraints bound the same state ids, proof modes,
owner, evidence, policy, and handoff fields so malformed fixtures fail closed at
parse time.

## Event Architecture

The accepted state record is the read model behind a small event flow:

- **Command** - record or revise a plan review state fixture.
- **Event** - a successful command appends a `planReview.StateAccepted` event.
- **Actor** - the Plan/Diff proof aggregate owns ordered fixture changes.
- **Event store** - accepted fixture events append to the durable design-proof
  event stream.
- **Projection** - a Plan/Diff projection folds events into the review state
  read model consumed by docs and downstream mockups.
- **Snapshot** - this package exports the accepted snapshot.
- **Read store** - consumers query the snapshot, not raw event history.

No runtime planner, projector, event store, approval engine, or production UI is
implemented here; this is design-time contract evidence.
