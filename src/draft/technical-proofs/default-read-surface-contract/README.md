# Default Read Surface Contract POC

Independent POC for HOBO-76, defining the default read surface over event-sourced materializations:

- `from(...eventTypes)` stream selection
- deterministic RX-style operators: `map`, `filter`, `scan`, `fold`, `distinctUntilChanged`,
  `combineLatest`, `join`, `window`, `buffer`, `debounce`, and `coalesce`
- `subscribe(materialization, args)` replay-then-live delivery
- `useSubscription` as hook-shaped sugar over the same subscription path
- `useQuery` as a naming alias over `useSubscription`

## What This Proves

- New subscribers receive the current folded value before any live push.
- Operator pipelines are deterministic and replayable.
- Hook-shaped subscriptions rerender on live pushes while carrying `{ data, seq, stale }`.
- Empty streams yield the materialization initial value, not an error.
- Back-to-back subscribers share one replay instead of double-folding history.
- Nondeterministic time-based operators are rejected unless seeded by the runtime.

## Scope Boundary

This is a client/read-surface contract POC only. It does not implement the Reactor engine, Streamer transport, GraphQL facade, snapshot cache, reads-your-writes advancement, sink adapters, or slow-client backpressure.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Default Read Surface Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
