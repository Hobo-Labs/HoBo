# HOBO-232 Relational Projection Sink Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32),
[ADR-0050](../../adr/03-data-plane.md#adr-0050), and
[ADR-0052](../../adr/03-data-plane.md#adr-0052).

The executable POC in
[`src/draft/technical-proofs/relational-projection-sink-contract`](../../../../src/draft/technical-proofs/relational-projection-sink-contract)
pins the M2 Postgres projection-sink reference boundary:

- read-model WIT fields map to a Postgres table, columns, primary key, secondary indexes, and
  enum checks;
- the mapping lowers to `wasi:sql/query@0.2.0` DDL;
- event-log replay materializes the relational rows and emits ordered `data.Changed` facts;
- cached point, filtered, and ordered reads carry `bounded-staleness`;
- drop plus replay rebuilds byte-identical rows and schema;
- the relational `@hobo/conformance` report covers mapping, ordered change-feed emission,
  bounded-staleness reads, and rebuild;
- out-of-order logical-replication changes normalize by `seq`, LSN, and key;
- WIT enum values outside the declared set fail closed instead of coercing.

Scope kept out: the generalized sink `change-feed` capability, app-DB expand/backfill/contract
migration machinery, the Mongo/document adapter, and the `@hobo/sql` idiom package.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\relational-projection-sink-contract test
```
