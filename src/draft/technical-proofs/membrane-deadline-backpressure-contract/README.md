# HOBO-598 Membrane Deadline + Backpressure Contract

Independent S1-09 draft POC promoting [HOBO-24](https://linear.app/quickdeploy-ai/issue/HOBO-24) deadline propagation and [HOBO-25](https://linear.app/quickdeploy-ai/issue/HOBO-25) membrane failure taxonomy into a single integrated membrane surface.

Production promotion target (S1-03 merged; pending S1-05 EventStore on `main`):

- `packages/core/src/failure/` — taxonomy, deadline, typed errors, parsers
- `packages/runtimes/runtime-local/src/membrane/` — deadline propagation, backpressure, reconciliation
- `packages/conformance/src/membrane/` — adversarial membrane-failure lane

## Proves

- Plan-05 six-class failure taxonomy with fail-closed `unknown-error-fail-closed` default
- Absolute deadlines on `link.Called` with nested inherit/shrink
- `DeadlineExceededError` classified transient (`backoff-budget`)
- Admission-controlled backpressure (`link.Rejected` before provider invoke)
- Mid-call severance/ambiguity as `partial-failure` with idempotency decision
- `reconcileAmbiguousFailure` outcomes: `deduped-eventstore-effect`, `provider-idempotency-forwarded`, `shed-overloaded`
- Eight conformance lane assertions (manual clock, no wall-clock sleeps)

## Out of scope

Wire-version negotiation (HOBO-26), NATS lattice (HOBO-27), deterministic retry scheduling (HOBO-516/517), saga engine, per-provider idempotency implementations.

```bash
pnpm --prefix src/draft/technical-proofs/membrane-deadline-backpressure-contract test
```

## Architecture Evidence

- `architecture/` — protobuf + CUE for Deadline, FailureClassification, link events
- `architecture/pacts/` — caller↔membrane typed error envelope PACT
- `ADR.md` — parse-don't-validate and event-architecture evidence
