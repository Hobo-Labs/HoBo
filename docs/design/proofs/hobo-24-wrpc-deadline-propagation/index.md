# HOBO-24 wRPC Deadline Propagation Proof

This proof backs [PLAN-20](../../wasm-runtime-wit.md#plan-20), [PLAN-05](../../reliability-observability-cost.md#plan-05), and [ADR-0069](../../adr/01-architecture-core.md#adr-0069).

The branch adds `src/draft/technical-proofs/wrpc-deadline-propagation-contract`, an independent POC for the M3 in-process wRPC deadline slice. It proves caller deadlines are carried on `link.Called`, exceeded deadlines return a typed `deadline-exceeded` result with the Plan-5 transient timeout classification, cancellable providers receive an abort signal, nested in-process calls inherit the parent's absolute deadline and shrink remaining time, and a hung in-process provider cannot hold the caller past the deadline.

Acceptance evidence:

- `slow provider exceeds caller deadline with typed Plan-5 timeout classification`
- `nested in-process call inherits and shrinks remaining deadline`
- `hung provider that ignores cancellation still returns deadline-exceeded to the caller`
- `report records HOBO-24 scope and keeps cross-host, backpressure, and retry reconciliation out`

Scope boundary:

- Included: in-process deadline propagation, `link.Called.deadline`, typed timeout result, cancellation signaling, nested remaining-deadline shrinkage, hung in-process timeout guard.
- Excluded: NATS/JetStream lattice transport, cross-host hung-call timing divergence, backpressure, retry/provider-idempotency reconciliation, full failure-classifier implementation, and wire-version negotiation.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-deadline-propagation-contract test
```

## Promotion note (S1-09 / HOBO-598)

Integrated draft POC at `src/draft/technical-proofs/membrane-deadline-backpressure-contract/` combines HOBO-24 deadline propagation with HOBO-25 membrane failure taxonomy for production promotion to `@hobo/core` + `@hobo/runtime-local` + `@hobo/conformance` (S1-03 merged; production promotion pending S1-05 EventStore on `main`).
