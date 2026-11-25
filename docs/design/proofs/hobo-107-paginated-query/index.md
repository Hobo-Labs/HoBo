# HOBO-107 Paginated Query Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32) and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/paginated-query-contract`](../../../../src/draft/technical-proofs/paginated-query-contract)
proves cursor-based pagination over a consistent snapshot@`seq`:

- pages use a cursor that encodes the sort-key position and id, not an offset;
- an insert before an already-issued cursor does not shift the later page;
- `usePaginatedQuery` subscribes to its page-window key range and re-pushes only for
  in-window `data.Changed` facts;
- `loadMore` extends the key range and makes the next page window reactive;
- non-indexed sort keys fail closed;
- deletes inside a page remove the row without phantom reads while preserving the tombstone
  `seq` in the page snapshot.

Scope kept out: Reactor scheduling, sink adapters, tenant filtering, search/vector pagination,
and the broader `repo`/`view` predicate DSL.
