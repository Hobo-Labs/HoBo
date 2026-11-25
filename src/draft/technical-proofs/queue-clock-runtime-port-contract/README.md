# Queue + Clock Runtime Port Contract POC

Independent POC for [HOBO-22](https://linear.app/quickdeploy-ai/issue/HOBO-22)
and [HOBO-596](https://linear.app/quickdeploy-ai/issue/HOBO-596), pinning the
runtime-local `Queue` and `Clock` ports required by ADR-0002 and Plan 2 / Plan
11.

> **Promotion (S1-07 / HOBO-596):** production ports landed in `packages/core`
> (`Queue`/`VirtualClock` interfaces + proto/CUE), `packages/runtimes/runtime-local`
> (`createRuntimeLocalQueueClock`, `replayClockTrace`), and `packages/conformance/`
> (`runQueueClockConformance` + `fixtures/runtime-ports/*`). This draft POC is
> retained for historical contract evidence; use production packages for new work.

## Contract Surface

- `createRuntimeLocalQueueClock()` exposes a local `queue`, deterministic
  `clock`, and serializable `snapshot()` for simulated restart.
- `queue.enqueue(name, body, { idempotencyKey })` provides at-least-once
  delivery with idempotency-key dedup before handling.
- `queue.handle(name, handler)` leases available messages, retries failed
  handlers without losing the message, and suppresses duplicate effects if a
  completed message is redelivered. Runtime-local handlers keep an active lease
  from being redelivered while the handler is still running.
- `queue.signal(actorKey, msg, { idempotencyKey })` maps actor messages onto an
  actor queue while preserving the same idempotency contract.
- `clock.sleep(runId, delayMs, { idempotencyKey })` schedules durable timers
  that survive snapshot/restore and fire once.
- `clock.cron(scheduleId, { everyMs })` models the runtime-local cron contract as
  a durable deterministic interval schedule. Full cron parsing/provider
  scheduling is intentionally outside this POC.
- `clock.advance(ms)` drives deterministic timer firing, and
  `replayClockTrace(trace, { seed })` proves seeded replay reproduces live fire
  order, timestamps, occurrence numbers, and fire ids.
- `runQueueClockConformance()` returns a machine-readable conformance report for
  the queue/clock subset.

## Acceptance Proof

- Idempotency-key dedup: duplicate enqueue and actor `signal` calls return the
  original message and invoke the handler once.
- Durable timer restart: a sleeping run and a pending cron schedule survive
  snapshot/restore, fire once, and remain fired across a second restart.
- Deterministic advance/replay: advancing the seeded clock wakes sleeping runs
  in the same order that trace replay reproduces.

## Adversarial Proof

- Duplicate delivery on redelivery is simulated with `queue.simulateRedelivery`;
  completed-message dedup prevents a second handler effect, and active handlers
  are not redelivered while their lease is still being processed locally.
- A timer cannot fire twice across crash because fired state is persisted in the
  snapshot.
- Seed mismatch and mutated fire facts are rejected before replay accepts a
  trace, preventing ambient clock nondeterminism from passing as deterministic
  replay.

## Scope Boundaries

Included:

- Runtime-local Queue enqueue/dequeue/handle/complete/release behavior.
- Idempotency-key dedup for enqueue, signal, and redelivered completions.
- Runtime-local deterministic sleep and interval-style cron timers.
- Snapshot/restore restart simulation and seeded replay trace assertions.

Excluded:

- Production queue backends such as Postgres, Temporal, Restate, Cloudflare, or
  cloud provider queues.
- Scheduler provider implementation or full cron expression parsing.
- Workflow replay-engine wiring beyond the clock trace conformance proof.

## Conformance fixtures

- `fixtures/redelivery-after-crash.ts` — crash before `complete`, snapshot
  restore, at-least-once redelivery with exactly-once effect ledger.
- `fixtures/time-travel-replay.ts` — interleaved `sleep` + `cron` under
  `advance()`, seeded `replayClockTrace` reproduces fire order and rejects seed
  mismatch / mutated fire facts.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/queue-clock-runtime-port-contract
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Queue Clock Runtime Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
