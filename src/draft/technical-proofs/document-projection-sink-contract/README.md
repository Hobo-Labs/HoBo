# Document Projection Sink Contract

Independent POC for HOBO-234. It proves the Mongo/document projection sink contract behind
`hobo:projection` without implementing the generalized change-feed capability, the relational
adapter, the `@hobo/document` idiom package, or KV/wide-column/graph/OLAP adapters.

The public surface models architect-owned mapping from a read-model WIT record to Mongo-style
documents, folds event-log facts into an in-memory document sink, normalizes Mongo change-stream
events into ordered `data.Changed` notifications, and exposes bounded-staleness point/find reads.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\document-projection-sink-contract test
```

## Proven Behaviors

- WIT record fields map to a Mongo collection, `_id` document key, nested embedded documents, indexes,
  and enum checks.
- The mapping realizes over the pinned `wasi:keyvalue/store@0.2.0` document-driver boundary.
- Event replay materializes documents and emits ordered `data.Changed` notifications.
- The same portable repo/view query result matches the native and Postgres projection shapes.
- The cached sink serves point, filtered, and ordered reads with a bounded-staleness label.
- Dropping the sink and replaying the same log rebuilds identical documents and schema.
- The document `@hobo/conformance` report covers mapping, ordered change-feed emission,
  bounded-staleness reads, and rebuild.
- Out-of-order Mongo change-stream events are sorted by `seq`, resume token, and key before
  publication.
- Cross-document joins fail closed instead of doing N+1 reads.
- Deeply nested records round-trip without field loss.
- Enum values outside the declared WIT enum fail closed with `ProjectionSinkMappingError`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Document Projection Sink Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
