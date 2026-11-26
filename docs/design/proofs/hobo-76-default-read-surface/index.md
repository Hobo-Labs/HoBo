# HOBO-76 Default Read Surface Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32) and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/default-read-surface-contract`](../../../../src/draft/technical-proofs/default-read-surface-contract)
proves the M1 default read-surface boundary:

- `subscribe(materialization)` delivers replay-then-live: a new subscriber gets the folded current
  value before later live pushes;
- `from(...eventTypes)` plus the deterministic RX-style operator vocabulary compose replayably:
  `map`, `filter`, `scan`, `fold`, `distinctUntilChanged`, `combineLatest`, `join`, `window`,
  `buffer`, `debounce`, and `coalesce`;
- `useSubscription` is hook-shaped sugar over the same subscription path and rerenders on pushes;
- `useQuery` is an alias over the subscription/materialization path, not a second read engine;
- empty streams yield the materialization initial value;
- back-to-back subscribers share one history replay;
- unseeded time-based operators fail closed, while seeded debounce stays deterministic.

Scope kept out: Reactor scheduling, Streamer transport, GraphQL facade generation, snapshot caching,
reads-your-writes advancement, sink adapters, and slow-client backpressure.
