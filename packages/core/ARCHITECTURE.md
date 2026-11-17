# @hobo/core — Architecture Evidence

S0-03 production package. Event envelope, port descriptors, Capability Manifest
schema, DI container, and public type-surface guard for `@hobo/core`.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that folder.
- PACT consumer/provider evidence lives under [`contracts/`](./contracts).

## Parse, don't validate

Untrusted input crosses one parser boundary into derived domain types. Parsers
throw typed `EnvelopeParseError`, `ManifestParseError`, or
`PortDescriptorParseError` and return deep-frozen derived types. Downstream code
receives parsed types instead of re-checking raw DTOs.

## Event architecture

- **Command** — request to append or change state (envelope `type` encodes the fact).
- **Event** — accepted commands append `EventEnvelope` records to the log.
- **Actor** — `actor` principal ref names who/what caused the event.
- **Event store** — durable source of truth for accepted envelopes (runtime slice).
- **Materialized view / projection** — folds the event store into queryable state.
- **Snapshot** — current read model is the projection snapshot.
- **Read store** — consumers query the read store, not the raw event log.

No runtime engine is implemented here; this package defines the envelope and
contract surfaces other packages compile against.

## Streamer port (HOBO-597)

- Port interfaces and branded parsers: [`src/ports/streamer.ts`](./src/ports/streamer.ts)
- Protobuf + CUE records: [`data-models/streamer_port.proto`](./data-models/streamer_port.proto)
- Production adapter: `@hobo/runtime-local` (`createLocalStreamer`)

## Ephemeral state port

- Port interface, branded parsers, lock and ring helpers, command-cost table: [`src/ports/ephemeral-state.ts`](./src/ports/ephemeral-state.ts)
- Protobuf + CUE records: [`data-models/ephemeral_state.proto`](./data-models/ephemeral_state.proto), [`data-models/ephemeral_state.cue`](./data-models/ephemeral_state.cue)
- Bindings: `@hobo/kv-redis-compatible` (Redis-protocol scripts, in-memory engine, RESP/TCP, conformance suite) and `@hobo/provider-upstash` (REST). Design: [`docs/design/relay-ephemeral-state.md`](../../docs/design/relay-ephemeral-state.md)

## Queue + Clock ports (HOBO-596)

- Port interfaces and branded parsers: [`src/ports/queue.ts`](./src/ports/queue.ts), [`src/ports/clock.ts`](./src/ports/clock.ts)
- Protobuf + CUE records: [`data-models/queue_port.proto`](./data-models/queue_port.proto), [`data-models/clock_port.proto`](./data-models/clock_port.proto)
- Production adapter: `@hobo/runtime-local` (`createRuntimeLocalQueueClock`)

## Durable messaging port

[`src/ports/durable-messaging.ts`](./src/ports/durable-messaging.ts) defines an
additive asynchronous port for group leases, durable acknowledgements and
dead-letter delivery. Mutation receipts distinguish committed, rejected,
unknown and expired outcomes. Expiry-bound operation IDs prevent an old retry
from becoming a new write after its receipt is collected. This contract does
not make the legacy synchronous `Messaging` port durable; an adapter must
implement and verify the new port separately.
Authorized compaction reclaims only fully settled prefixes and returns the
retained sequence floor. A later earliest subscriber is told when earlier
history was truncated. Acknowledgements bind the topic, group, caller message
ID, message sequence and lease ID, including when a compacted ID is reused.
If a provider cannot rule out a prior commit while
retrying, including after authorization or receipt-store failures, the outcome
remains unknown rather than becoming a rejection.
