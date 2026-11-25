# Known Limitations Register Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted
limitation records are parsed once into the `ParsedKnownLimitationsRegister`
parsed domain type, and release-note, support-script, docs, and launch-messaging
consumers receive that parsed register or its customer-safe projection. CUE
constraints bound the same derived type so missing owners, stale checkpoints,
unsupported state, or scope-out marketing errors are rejected at the boundary.

## Event Architecture

The accepted register is the read model behind a small event flow:

- **Command** - a request to record, review, or publish a known limitation.
- **Event** - successful commands append `release.limitation.*` evidence facts.
- **Actor** - the release-note limitation aggregate applies events in order.
- **Event store** - accepted facts are appended to the durable release-readiness
  event store.
- **Materialized view / projection** - a projection folds events into current
  limitation state, handoff targets, and beta/GA review freshness.
- **Snapshot** - the register is the release-note snapshot consumed by launch,
  support, docs, and messaging surfaces.
- **Read store** - consumers query the snapshot instead of inferring support
  promises from raw issue text.

No release-note CMS, support workflow, launch site, event store, projector, or
production publishing system is implemented here; this is a design-time contract
that names the command, event, actor, projection, PACT, protobuf, and CUE
boundaries for later implementation.
