# HOBO-288 - Reactor Coalescing Fan-out Proof

This proof pins the adversarial Reactor hardening contract for out-of-order
events, coalescing/backpressure, and bounded cross-cutting fan-out:

- Fuzzed out-of-order and interleaved appends converge to the same
  materialized value as canonical causal/sequence order.
- Client pushes never regress per-stream `seq` vectors.
- Slow clients keep one coalesced pending snapshot and receive the latest `seq`
  when they resume.
- `flag.Changed` and `session.Revoked` fan-out work is enqueued into a bounded,
  sharded, rate-limited queue with no synchronous push spike.
- Duplicate event ids are idempotent and do not double-apply.
- Local subscription work is prioritized while global fan-out remains queued.

Executable proof lives in `src/draft/technical-proofs/reactor-coalescing-fanout-contract`.

Scope intentionally excludes Reactor core implementation, queue provider ports,
auth/flag read-set ownership, and poison event handling.
