# Promoted from the README's prose gherkin; every step drives
# services/foundations-reference-architecture.ts (the epic's real simulation).
# Narrowing note: the README lists six persona scenarios; the "compile against
# shared core and WIT contracts" and "keep traceability docs aligned" scenarios
# stay proven by tests/reference-architecture.test.ts — this feature distills
# the four bootstrap/build/trust/CI paths the simulation exposes end to end.
Feature: Foundations, build, and conformance harness
  The foundations harness validates the workspace skeleton, builds a
  deterministic hello-bindle component, gates artifacts behind signature
  verification, and runs mocked CI without stored secrets — failing closed on
  every boundary violation.

  Scenario: Bootstrap a package skeleton with boundary lint
    Given a design-phase HoBo workspace contract
    When the workspace skeleton is validated
    Then required packages validate and adapter boundary violations are denied

  Scenario: Build a deterministic hello-bindle component
    Given the hello-bindle source fixture
    When the fixture is componentized
    Then wasm validation, the OCI descriptor, and smoke output are deterministic

  Scenario: Verify signed artifacts before Matching can see them
    Given a signed artifact and its conformance report
    When install verification runs in the trust gate
    Then the artifact is available to Matching but not auto-selected and unsigned artifacts are refused

  Scenario: Run PR gates and hello-bindle E2E without stored secrets
    Given the mocked CI fabric contract
    When the CI and opt-in E2E lanes run
    Then OIDC-scoped short-lived tokens gate the run and missing OIDC fails the lane
