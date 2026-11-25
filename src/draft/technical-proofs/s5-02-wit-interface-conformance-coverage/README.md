# HOBO-647 Per-WIT-Interface Conformance Coverage POC

Independent draft proof for **S5-02**: per-WIT-interface conformance suites, a
machine-readable coverage report, and a Registry publish gate that blocks listing
unless every claimed interface passes.

## Requirements Source

- `docs/design/generated-stack.md#plan-09`: `@hobo/conformance` is the trust
  boundary; conformance is **per WIT interface** and gates provider listing.
- `docs/design/adr/03-data-plane.md#adr-0010`: generated providers certify only
  by satisfying the target WIT port and conformance suite.
- `src/draft/epic-proofs/foundations-build-conformance-harness/`: conformance
  evidence matrix (suite required before adapter trust).
- `src/draft/epic-proofs/providers-iac-build-adapters/`: provider conformance
  gate PACT (`provider-conformance-gate`).

## Contract Surface

- `loadWitCapabilityCatalog()` / `parseWitCapabilityCatalog()`: fixture catalog
  of `hobo:capability/*` interfaces representing `packages/wit/` inventory.
- `createSuiteRegistry()`: one conformance suite per catalog interface (reuses
  `conformance-port-suite-contract` harness).
- `buildCoverageReport()`: machine-readable `hobo.conformance.wit-coverage-report/v1`.
- `recertifyProvider()`: per-interface conformance run for a provider's claimed ports.
- `evaluatePublishGate()`: Registry listing disposition (`listed` | `blocked`).
- `runS4ProviderRecertificationMatrix()`: AWS/Azure/Cloudflare re-cert under the gate.

## What This Proves

- Coverage report reaches **100%** when every `hobo:capability/*` interface is
  suite-backed.
- Missing suites surface as `coverage.missing-suite:*` gaps and block completeness.
- Publish gate **blocks** when any claimed interface fails conformance.
- Forged reports are rejected (`conformance.forged-report`).
- S4 seed providers (`@hobo/provider-aws`, `-azure`, `-cloudflare`) pass
  per-interface re-certification when suites and adapters are green.

## Scope Boundary

Does **not** implement production `packages/conformance/` expansion, real WIT
files in `packages/wit/`, Registry runtime, signing, or CI wiring. Those land
after S5-01 merges. This is the executable contract slice for that work.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s5-02-wit-interface-conformance-coverage test
```

## Architecture Evidence

- `architecture/` — protobuf + CUE evidence for the coverage report boundary.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate derived types plus command/event/actor/event-store/projection/snapshot/read-store naming for CQRS promotion.
