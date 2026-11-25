# Reactor Skeleton Contract POC

Independent POC for HOBO-80, defining the native log-backed Reactor skeleton:

- active subscriptions hold `{ materialization, args, readSet, lastSeq, client }`;
- an inverted `stream/event-type -> subscriptions` index wakes only affected subscriptions;
- each wake recomputes a consistent materialization snapshot at the current per-stream `seq`;
- changed snapshots push `subscription.Pushed` events to the attached client;
- subscription facts are exported and replayed so active subscriptions rebuild after failover.

## Acceptance Evidence

- `subscribe` then append an in-read-set event pushes the new `seq` and materialized value.
- Appending outside every active read-set wakes no subscriptions and sends no push.
- Pushes for a burst on one stream stay monotonic and ordered by `seq`.
- Restarting with the event log plus subscription projection rebuilds the active subscription.

## Adversarial Evidence

- Multi-stream read-sets advance each stream independently using a per-stream `seq` map.
- Identical recomputes update internal position but suppress spurious client pushes.

## Scope Boundary

This package intentionally stops at the native log path. It does not implement slow-client
coalescing/backpressure, high-cardinality fan-out queues, reads-your-writes advance before write
ack, provider `change-feed` ingestion, or the GraphQL facade.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\reactor-skeleton-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Reactor Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
