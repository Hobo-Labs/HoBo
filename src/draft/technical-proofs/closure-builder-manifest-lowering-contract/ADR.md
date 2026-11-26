# Closure Builder Manifest Lowering - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted closure-builder capture
facts are parsed once at the lowering boundary into derived domain types, and downstream consumers
receive parsed manifest and WIT call records instead of raw DTOs. The CUE constraints bound the same
derived types so malformed generated IDs, aliases, relationships, and same-kind identity-ledger
requirements are rejected at parse time rather than passed downstream.

## Event Architecture

The accepted lowering record is the read model behind this event flow:

- **Command** - `LowerClosureBuilderGraph` requests a canonical manifest lowering for captured
  closure-builder resource facts.
- **Event** - `closureBuilder.ManifestLowered` records the generated manifest ID graph, WIT call
  stream, alias projection, and fail-closed HOBO-538 boundary status.
- **Actor** - the Bindle authoring aggregate is the actor that owns the lowering command and applies
  events in order for one Bindle graph.
- **Event store** - accepted lowering events are appended to the platform event store as the durable
  source of truth.
- **Materialized view / projection** - the SDK conformance projection folds the event store into the
  golden lowering corpus used by `@hobo/conformance/sdk`.
- **Snapshot** - the manifest lowering result is the snapshot of that projection for one Bindle.
- **Read store** - conformance, codegen, and planner tests query the read store rather than raw
  closure-builder capture facts.

No runtime engine, projector, event store, provider resolver, or app host is implemented here; this
is a design-time contract that names the command, event, actor, projection, snapshot, and read-store
boundaries for later implementation.
