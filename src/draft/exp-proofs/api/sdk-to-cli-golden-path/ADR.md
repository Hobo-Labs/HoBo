# SDK-to-CLI Golden Path - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted SDK-to-CLI transcript input
is parsed once at the proof boundary into a derived `SdkToCliGoldenPathRecord`. Downstream
consumers receive that parsed record instead of raw command strings, fixture ids, or result-kind
strings that must be rechecked at every call site. The CUE constraints bound the same derived types
so unrecognized result kinds, missing proof modes, fixture-id drift, provider logic in the SDK
consumer, or scope-creep claims are rejected at parse time.

## Event Architecture

The accepted transcript is the read model behind a small event flow:

- **Command** - `sdkToCliGoldenPath.TranscriptRequested` asks the Developer Experience fixture owner
  to record or amend the accepted SDK-to-CLI transcript.
- **Event** - `sdkToCliGoldenPath.TranscriptAccepted` appends the parsed record, contract artifact
  references, proof-mode labels, and downstream handoff list.
- **Actor** - the CLI, MCP & Developer Experience proof owner is the aggregate that applies
  accepted transcript events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds the event store into the SDK-to-CLI
  golden-path read model.
- **Snapshot** - the current accepted transcript is the projection snapshot used by docs,
  tutorial, troubleshooting, plan/diff, and dashboard owners.
- **Read store** - downstream surfaces query the read store rather than raw Linear comments or
  ad hoc transcript text.

No runtime engine, production deploy, package publication, live MCP server, dashboard screenshot,
or provider adapter is implemented here. This is a design-time contract that names the command,
event, actor, projection, snapshot, and read-store boundaries so later implementation inherits a
consistent vocabulary.
