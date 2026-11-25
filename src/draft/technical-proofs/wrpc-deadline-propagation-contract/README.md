# HOBO-24 wRPC Deadline Propagation Contract

Independent POC for deadline propagation across in-process wRPC links.

It proves:

- caller deadlines are carried on `link.Called`;
- exceeded deadlines return typed `deadline-exceeded` errors with the Plan-5 transient timeout classification;
- cancellable provider operations receive an `AbortSignal`;
- nested in-process calls inherit the parent deadline and shrink remaining time;
- hung in-process providers cannot hold the caller past the deadline.

Out of scope: NATS/JetStream lattice transport, cross-host hung-call timing divergence, backpressure, retry/provider-idempotency reconciliation, full classifier implementation, and wire-version negotiation.

**S1-09 promotion:** integrated with HOBO-25 in `src/draft/technical-proofs/membrane-deadline-backpressure-contract/` (HOBO-598). Production target: `packages/core/src/failure/` + `packages/runtimes/runtime-local/src/membrane/deadline-propagation.ts`.

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-deadline-propagation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wrpc Deadline Propagation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
