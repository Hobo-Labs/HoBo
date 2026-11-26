# Foundations, Build & Conformance Harness Reference Implementation

This is the epic-level reference architecture implementation for Linear project `648882d1-6039-4ed5-b771-6df8fd1a96d4`.

It rolls up the Foundations POCs into one mocked vertical slice: a platform engineer can bootstrap the package skeleton, prove shared core and WIT contracts, build `hello-bindle` as a deterministic wasm component, verify artifact trust, run CI/E2E gates, and keep hardening/traceability aligned.

## What is real

- The service composes existing executable POCs from `src/draft/`.
- Consumer tests load Pact-format fixtures for every mocked service boundary.
- The simulation runs locally without live GitHub, cloud, registry, Sigstore, or OIDC calls.
- Negative cases fail closed for adapter cross-imports, provider-specific core type leakage, missing OIDC, and unsigned artifacts.

## What is mocked

- GitHub Actions, OIDC issuer, sandbox cloud, registry trust boundary, and artifact signing keys are deterministic fixtures.
- Provider verification is unavailable because production providers do not exist in this design-phase repo.

## Running

```bash
npm.cmd --prefix src\draft\epic-proofs\foundations-build-conformance-harness test
npm.cmd --prefix src\draft\epic-proofs\foundations-build-conformance-harness run simulate
```

## BDD slices

```gherkin
Feature: Foundations, Build and Conformance Harness

  Persona: Platform engineer
  Scenario: bootstrap a package skeleton with boundary lint
    Given a design-phase HoBo workspace contract
    When the skeleton is validated
    Then required packages, scripts, and adapter boundary failures are observable

  Persona: Provider author
  Scenario: compile against shared core and WIT contracts
    Given the shared core and hobo:sdk WIT contract
    When a provider manifest and WIT lock are validated
    Then boundary schemas and generator floors remain stable

  Persona: Application developer
  Scenario: build a deterministic hello-bindle component
    Given the hello-bindle source fixture
    When it is componentized
    Then wasm validation, OCI descriptor, and smoke output are deterministic

  Persona: SecOps reviewer
  Scenario: verify signed artifacts before Matching can see them
    Given a signed artifact and conformance report
    When install verification runs
    Then the artifact is available to Matching but not auto-selected

  Persona: Maintainer
  Scenario: run PR gates and opt-in hello-bindle E2E without stored secrets
    Given the CI fabric contract
    When mocked CI/E2E runs
    Then OIDC, teardown, sweeper, quarantine, and cost gates are covered

  Persona: Design maintainer
  Scenario: keep package, API, and traceability docs aligned
    Given the package namespace and traceability docs
    When hardening checks run
    Then PLAN-10 and ADR coverage remain anchored to issue families
```

## Files

- `services/foundations-reference-architecture.ts`
- `tests/reference-architecture.test.ts`
- `contracts/consumer/foundations-boundaries.test.ts`
- `contracts/pact-inventory.md`
- `poc-rollup-ledger.md`
- `scope-review.md`
- `reference-implementation.yaml`


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Foundations Build Conformance Harness.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `slsa-provenance-certification-contract` technical proof refresh is absorbed without changing build provenance or conformance evidence.
