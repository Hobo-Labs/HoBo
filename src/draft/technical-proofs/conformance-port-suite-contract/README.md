# Conformance Port Suite Contract POC

Independent POC for HOBO-5. It pins the branch-sized contract for the
`@hobo/conformance` port-suite harness and the SDK parity report lane.

> **Promotion note (HOBO-585):** the typed, event-sourced harness is promoted to
> [`packages/conformance/`](../../../../packages/conformance/README.md) as the
> production `@hobo/conformance` package. This proof remains historical evidence
> for the branch-sized contract semantics.

## Requirements Source

- `docs/design/generated-stack.md#plan-09`: `@hobo/conformance` is the trust boundary for generated and third-party adapters.
- `docs/design/adr/03-data-plane.md#adr-0010`: generated providers are certified only by satisfying the target WIT port and conformance suite.
- `docs/design/adr/01-architecture-core.md#adr-0072`: SDK idiom layers are gated by golden-IR lowering equivalence plus replay.
- `docs/design/adr/01-architecture-core.md#adr-0093`: SDK semantics annex is a separate required lane from golden-IR equality.

## Contract Surface

- `createConformanceSuite(definition)`: normalizes a per-port contract suite with claimed port functions and coverage requirements.
- `runConformanceSuite(suite, adapter, options)`: runs the adapter against each case, compares expected output, golden IR, replay traces, coverage, provenance, and the claimed-port listing disposition.
- `evaluateSdkParity(report)`: checks the `@hobo/conformance/sdk` parity report boundary for language-neutral golden IR and required semantics-annex categories.

## What This Proves

- A toy adapter that satisfies output, golden-IR, and replay-trace expectations receives a passing report.
- A deliberately broken adapter fails with a precise JSON-path diff.
- Every report carries suite, port, adapter, seed, and case provenance.
- Passing adapters are `listed`; failing adapters are `blocked` with failure codes for CI/unlisting consumers.
- Golden-IR changes and replay-trace regressions are reported as separate failures.
- Claimed-but-unexercised port functions fail the coverage manifest.
- Nondeterministic suites fail under a stable seed.
- SDK parity rejects language-specific golden-IR fields and missing annex vectors for error mapping, cancellation, async ordering, and IfC side-effect order.

## Scope Boundary

This proof is not the production package; HOBO-585 promotes its harness semantics to `packages/conformance/`. Real runtime/provider port suites, provider certification, CI publishing integration, signing, and the full multi-language SDK matrix remain separate slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\conformance-port-suite-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Conformance Port Suite Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
