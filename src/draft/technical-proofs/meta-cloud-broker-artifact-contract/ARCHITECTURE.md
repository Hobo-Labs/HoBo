# Meta-cloud Broker Artifact Contract - Architecture Evidence

This package carries the architecture-guard evidence for HOBO-522.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted artifact envelopes are parsed
once by `parseBrokerArtifactSet` into parsed domain types. Downstream proof code receives those
parsed domain types rather than re-checking broad DTOs. The parser rejects unsigned, unversioned,
ownerless, ambiguous, or policy-masquerading artifacts before `evaluateBrokerArtifacts` can produce
a deterministic receipt or rejection fixture.

## Event Architecture

The package is a design-time contract over the broker artifact projection:

- **Command** - record a candidate Contract Manifest, Broker Environment, Mapping Contract, and
  Broker Catalog Snapshot artifact set.
- **Event** - append `brokerArtifact.Accepted` or `brokerArtifact.Rejected` with deterministic
  receipt or rejection evidence.
- **Actor** - the Meta-cloud Broker artifact aggregate owns one artifact-set digest and applies
  events in order.
- **Event store** - accepted artifact events are appended to HoBo's platform event store.
- **Materialized view / projection** - a projection folds artifact events into the current broker
  artifact evidence view consumed by support, Yard handoff, and later runtime work.
- **Snapshot** - the current artifact-set digest plus receipt/rejection evidence is the snapshot.
- **Read store** - downstream surfaces query the read store rather than raw event streams.

No hosted broker runtime, Yard planner, provider adapter, admin UI, or Gatekeeper implementation is
provided here.
