# Relational Projection Sink Contract

Independent POC for HOBO-232. It proves the Postgres projection sink contract behind
`hobo:projection` without implementing the generalized change-feed capability, schema
migration machinery, Mongo adapter, or `@hobo/sql` idiom package.

The public surface models the architect-owned mapping from a read-model WIT record to a
relational table, folds event-log facts into rows, and normalizes Postgres logical
replication changes into ordered `data.Changed` notifications.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\relational-projection-sink-contract test
```

## Proven Behaviors

- WIT record fields map to Postgres columns, tables, primary keys, secondary indexes, and enum checks.
- The mapping lowers to `wasi:sql/query@0.2.0` DDL statements.
- Event replay materializes rows into the relational shape and emits ordered `data.Changed` notifications.
- The cached sink serves point, filtered, and ordered reads with a bounded-staleness label.
- Dropping the sink and replaying the same log rebuilds identical rows and schema.
- The conformance report covers mapping, ordered change-feed emission, bounded-staleness reads, and rebuild.
- Out-of-order logical replication changes are sorted by `seq`, LSN, and key before publication.
- Reads are explicitly labeled `bounded-staleness`.
- Enum values outside the declared WIT enum fail closed with `ProjectionSinkMappingError`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Relational Projection Sink Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
