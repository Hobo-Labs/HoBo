# PACT Contract Harness — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`data-models/contract-harness.proto`](./data-models/contract-harness.proto).
- CUE constraints in [`data-models/contract-harness.cue`](./data-models/contract-harness.cue) bound every protobuf message.
- Executable PACT contracts live under [`contracts/pacts/`](./contracts/pacts) with consumer/provider lanes.

## Parse, Don't Validate

Untrusted pact JSON crosses exactly one parser boundary: `parsePactDocument` returns
derived `PactDocument` types that already satisfy the CUE constraints. Downstream
harness code (`verifyPact`, `createMockProviderFromPact`, `checkPactInventory`) and
the reference consumer (`parseCoreContractSurface`) accept only parsed derived types,
never raw DTOs with repeated boolean checks.

## Event Architecture

This package is pure test infrastructure and holds no durable write model. For the
harness records themselves:

- **Command** — `VerifyPact` / `LoadPactDirectory` requests to validate or load contracts.
- **Event** — verification produces derived `VerificationReport` values; no events are appended to a store.
- **Actor** — the harness library is stateless; callers own any future actor boundaries.
- **Event store** — not used; pact files are versioned source artifacts, not an event log.
- **Materialized view / projection** — `VerificationReport` is a derived projection over replayed interactions, never mutated in place.
- **Snapshot** — inventory tables (`pact-inventory.md`) are static snapshots of declared boundaries.
- **Read store** — tests read pact JSON and inventory markdown from disk; no query surface is exposed at runtime.

No runtime engine, projector, or event store is implemented here. S1+ service boundaries
that adopt this harness will name their own command/event families beside their pacts.
