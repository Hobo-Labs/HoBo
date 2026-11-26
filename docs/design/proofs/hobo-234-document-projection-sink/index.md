# HOBO-234 Document Projection Sink Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32),
[ADR-0050](../../adr/03-data-plane.md#adr-0050), and
[ADR-0052](../../adr/03-data-plane.md#adr-0052).

The executable POC in
[`src/draft/technical-proofs/document-projection-sink-contract`](../../../../src/draft/technical-proofs/document-projection-sink-contract)
pins the M2 Mongo/document projection-sink reference boundary:

- read-model WIT fields map to a Mongo collection, `_id` document key, embedded nested records,
  secondary indexes, and enum checks;
- the mapping lowers to the pinned `wasi:keyvalue/store@0.2.0` document-driver surface;
- event-log replay materializes documents and emits ordered `data.Changed` facts;
- the same portable repo/view query resolves byte-identically over the native, Postgres, and Mongo
  projection shapes;
- cached point, filtered, and ordered reads carry `bounded-staleness`;
- drop plus replay rebuilds byte-identical documents and schema;
- the document `@hobo/conformance` report covers mapping, ordered change-feed emission,
  bounded-staleness reads, and rebuild;
- out-of-order Mongo change-stream events normalize by `seq`, resume token, and key;
- cross-document joins fail closed rather than falling back to N+1 reads;
- deeply nested records round-trip without field loss;
- WIT enum values outside the declared set fail closed instead of coercing.

Scope kept out: the generalized sink change-feed capability, the relational adapter, the
`@hobo/document` idiom package, and KV/wide-column/graph/OLAP adapters.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\document-projection-sink-contract test
```
