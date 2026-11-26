# HOBO-237 Proof: Projection-Sink Change-Feed Conformance

HOBO-237 generalizes `change-feed` from the database port to a capability any `projection-sink` provider may advertise.

Proof package: [`src/draft/technical-proofs/projection-sink-change-feed-conformance-contract`](../../../../src/draft/technical-proofs/projection-sink-change-feed-conformance-contract)

## Requirement Coverage

- A sink advertising `change-feed` passes an ordered `data.Changed` conformance fixture for insert/update/delete.
- A non-relational `kv` sink advertising `change-feed` is declared reactive through the same projection-sink contract.
- A sink without `change-feed` is declared and typed `reactive: false`.
- A `"use query"` live view over that sink emits a `hobo doctor` warning.
- A one-shot snapshot over that same non-reactive sink still returns rows.
- Out-of-order feeds, dropped deletes, and double-emitted operations fail the conformance suite.

## Verification

```powershell
npm.cmd --prefix src/draft/technical-proofs/projection-sink-change-feed-conformance-contract test
npm.cmd test
npm.cmd run docs:design-lint
node scripts/validate-traceability.ts
```

Scope intentionally excludes Postgres/Mongo adapter implementations, Reactor changes, and provider driver code; those consume this contract in their own slices.
