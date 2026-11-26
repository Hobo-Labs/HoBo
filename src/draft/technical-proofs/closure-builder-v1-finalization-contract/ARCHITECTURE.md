# Closure Builder V1 Finalization Contract Architecture

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Finalization evidence is parsed once by
`assertClosureBuilderV1Finalization` into derived domain types:
`ClosureBuilderV1FinalizationRecord` and `ClosureBuilderEvidenceEntry`.
Downstream checks consume those parsed records and do not accept broad raw DTOs
with repeated boolean checks.

## Event Architecture

- **Command** - `FinalizeClosureBuilderV1Api`.
- **Event** - `closureBuilder.V1FinalizationAccepted`.
- **Actor** - the SDK contract actor owns the parent closure-builder
  finalization record.
- **Event store** - accepted finalization evidence events are appended to the
  design-contract event store.
- **Projection** - SDK docs and release-readiness consumers read the
  finalization projection.
- **Snapshot** - this proof package and Pact fixture are the current review
  snapshot.
- **Read store** - v1 authoring docs consume the snapshot rather than raw
  Linear issue text.

No child builder behavior, provider resolution, runtime app-host behavior, or
production codegen is implemented here.
