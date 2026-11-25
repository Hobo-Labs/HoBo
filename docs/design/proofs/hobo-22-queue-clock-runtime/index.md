# HOBO-22 Queue + Clock Runtime Proof

This proof backs [PLAN-02](../../sdk-api.md#plan-02),
[PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-11](../../data-plane.md#plan-11),
[PLAN-09](../../generated-stack.md#plan-09),
[ADR-0002](../../adr/01-architecture-core.md#adr-0002), and
[ADR-0003](../../adr/01-architecture-core.md#adr-0003).

The executable POC in
[`src/draft/technical-proofs/queue-clock-runtime-port-contract`](../../../../src/draft/technical-proofs/queue-clock-runtime-port-contract)
pins the HOBO-22 / HOBO-596 runtime-local Queue + Clock boundary:

- `queue.enqueue` / `queue.signal` dedup on `idempotencyKey` before handling;
- at-least-once delivery with lease, retry on handler failure, and completed-message dedup on redelivery;
- active in-process handlers are not redelivered while their lease is held;
- `clock.sleep` / `clock.cron` (interval-only) survive snapshot/restore and fire once;
- seeded `clock.advance` + `replayClockTrace` prove deterministic replay == live fire facts;
- `runQueueClockConformance()` reports six machine-readable assertions;
- `fixtures/redelivery-after-crash` and `fixtures/time-travel-replay` exercise the
  S1-07 acceptance scenarios.

Scope kept out: production queue/scheduler backends, full cron parsing, ActorHost
lease acquisition, Streamer port, and durable-workflow replay engine wiring.

## Promotion

S1-07 ([HOBO-596](https://linear.app/quickdeploy-ai/issue/HOBO-596)) promoted draft semantics into
`packages/core` (`Queue`/`VirtualClock` ports + proto/CUE),
`packages/runtimes/runtime-local` (`createRuntimeLocalQueueClock`, `replayClockTrace`),
and `packages/conformance` (`runQueueClockConformance` + runtime-port fixtures) on
`main` after S1-05 EventStore ([HOBO-594](https://linear.app/quickdeploy-ai/issue/HOBO-594)).

Draft POC remains at
[`src/draft/technical-proofs/queue-clock-runtime-port-contract`](../../../../src/draft/technical-proofs/queue-clock-runtime-port-contract)
for historical reference; production code is authoritative.

## Verification

```bash
pnpm exec turbo run test --filter @hobo/runtime-local --filter @hobo/conformance
pnpm exec turbo run test --filter ./src/draft/technical-proofs/queue-clock-runtime-port-contract
```
