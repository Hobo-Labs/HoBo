# Contract Engine Port Contract

Independent POC for HOBO-119.

This pins the `hobo:contract-engine/contract-engine@0.1.0` seam and proves the built-in contract
engine behavior:

- derives consumer expectations from the HoBo graph and event log;
- verifies a producer/consumer pair without a hand-written Pact file;
- exports/imports a Pact broker shape only as an interop target over the Contract IR;
- rejects behavior toggles or second engine providers because the contract engine is built-in-only.

The POC intentionally does not implement the can-deploy compatibility matrix, observed trace-mining,
or the full Contract IR. Those are separate slices.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Contract Engine Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
