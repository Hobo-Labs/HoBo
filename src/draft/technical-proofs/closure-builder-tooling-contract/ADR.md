# Closure Builder Tooling Contract Architecture

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A Pact contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

Closure-builder source is parsed once by `evaluateClosureBuilderTooling` into a
derived manifest, coverage result, and generated alias declarations. Downstream
tooling checks consume those derived records and do not accept raw DTOs with
repeated boolean checks. The parsed derived types are
`ClosureBuilderManifest`, `ClosureBuilderResource`, `ClosureBuilderRelationship`,
`ClosureBuilderCoverage`, and `ClosureBuilderDiagnostic`.

## Event Architecture

- **Command** - `EvaluateClosureBuilderTooling`.
- **Event** - `closureBuilder.ToolingEvaluated`.
- **Actor** - the SDK tooling actor owns one closure-builder source snapshot.
- **Event store** - accepted tooling-evidence events are appended to the
  design-contract event store.
- **Projection** - coverage, collect, codegen, and scaffold consumers read the
  derived tooling projection.
- **Snapshot** - this proof package and Pact fixture are the current review
  snapshot.
- **Read store** - HOBO-537 author-flow proof consumes the snapshot rather than
  raw issue text.

No production CLI, runtime provider, or app-host behavior is implemented here.
