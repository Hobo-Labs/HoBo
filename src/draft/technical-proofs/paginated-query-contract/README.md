# Paginated Query Contract POC

Independent POC for HOBO-107, defining cursor-based pagination over a consistent
page-window snapshot.

## Contract

- `view(store, "tickets").order("createdAt").paginate({ cursor, limit })` returns
  `{ items, nextCursor, seq }`.
- `nextCursor` encodes the sort-key position and row id, never an offset.
- `usePaginatedQuery(...)` subscribes to the current page-window key range.
- `loadMore()` extends that key range from the current cursor window to the next one.
- Sort keys must be declared indexable by the sink; non-indexed sorts fail closed.

## Proof

- Stable cursor pages do not shift when a row is inserted before an already-issued cursor.
- In-window `data.Changed` facts re-push the page at a non-regressing `seq`.
- Out-of-window changes do not wake the page query until `loadMore()` extends the window.
- Deleting a row inside the current window removes it without returning a phantom row, while
  the tombstone `seq` remains visible in the page snapshot.

## Scope Boundary

This package proves the pagination contract only. It does not implement the Reactor, sink adapters,
search/vector top-k pagination, tenant policy, or a full `repo`/`view` predicate DSL.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Paginated Query Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
