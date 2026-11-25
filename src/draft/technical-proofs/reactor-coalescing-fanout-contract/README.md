# Reactor Coalescing Fan-out Contract POC

Independent POC for HOBO-288, proving adversarial ordering, idempotency,
coalescing/backpressure, and bounded cross-cutting Reactor fan-out.

## Acceptance Evidence

- Fuzzed out-of-order and interleaved appends preserve per-stream `seq`
  monotonicity and converge to the same materialized value as canonical order.
- Burst updates for a slow client coalesce to the latest `seq` instead of
  building an unbounded backlog.
- A global `flag.Changed` event over many subscriptions drains through a
  bounded, sharded fan-out queue without synchronous pushes.
- Repeated global fan-out preserves per-subscription ordering.

## Adversarial Evidence

- Duplicate event ids are idempotent and do not double-apply.
- Slow clients retain one coalesced pending snapshot while paused.
- Local subscription work is prioritized while a large global fan-out is still
  queued, preventing starvation.
- Arrival order and causal/sequence order produce the same materialized value.

## Scope Boundary

This package is a contract harness only. It does not implement the Reactor core,
queue provider ports, auth or flag read-set membership, poison event handling, or
runtime transport.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\reactor-coalescing-fanout-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Reactor Coalescing Fanout Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
