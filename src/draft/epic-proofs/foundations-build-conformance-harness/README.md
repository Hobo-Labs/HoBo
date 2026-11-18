# Foundations, Build & Conformance Harness Reference Implementation

This is the epic-level reference implementation for project `648882d1-6039-4ed5-b771-6df8fd1a96d4`.

It rolls up the Foundations POCs into one mocked vertical slice: a platform engineer can bootstrap the package skeleton, prove shared core and WIT contracts, build `hello-bindle` as a deterministic wasm component, verify artifact trust, run CI/E2E gates, and enforce source policy.

## What is real

- The service composes existing executable POCs from `src/draft/`.
- Consumer tests load Pact-format fixtures for every mocked service boundary.
- The simulation runs locally without live GitHub, cloud, registry, Sigstore, or OIDC calls.
- Negative cases fail closed for adapter cross-imports, provider-specific core type leakage, missing OIDC, and unsigned artifacts.

## What is mocked

- GitHub Actions, OIDC issuer, sandbox cloud, registry trust boundary, and artifact signing keys are deterministic fixtures.
- Provider verification is unavailable because production providers are outside this fixture.

## Running

```bash
npm.cmd --prefix src\draft\epic-proofs\foundations-build-conformance-harness test
npm.cmd --prefix src\draft\epic-proofs\foundations-build-conformance-harness run simulate
```

## Files

- `services/foundations-reference-architecture.ts`
- `tests/reference-architecture.test.ts`
- `contracts/consumer/foundations-boundaries.test.ts`
- `reference-implementation.yaml`


## Executable evidence
This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Foundations Build Conformance Harness.
- `architecture/pacts/` — PACT contract for the package boundary.

## Cascade reconciliation (83d9b5c92)

The `slsa-provenance-certification-contract` technical proof refresh is absorbed without changing build provenance or conformance evidence.
