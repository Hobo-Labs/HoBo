# Registry Capability Manifest Ingest Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is
parsed once at the boundary into derived domain types, and downstream consumers
receive those parsed, derived types instead of re-checking raw input. The CUE
constraints bound the same derived types so malformed input is rejected at parse
time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `IngestCapabilityManifest` crawls `/.well-known/capability-manifest/` and verifies signatures.
- **Event** — `ProviderRegistered` and `CapabilityManifestUpdated` append to the registry event log.
- **Actor** — the Registry catalog actor owns manifest ingest and indexing.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — capability search and planner capability
  source fold events into queryable indexes.
- **Snapshot** — the stored plugin record with provenance and conformance is the
  snapshot of that projection.
- **Read store** — Planner and MCP `search_registry` query that read store rather
  than re-fetching provider well-known paths.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
