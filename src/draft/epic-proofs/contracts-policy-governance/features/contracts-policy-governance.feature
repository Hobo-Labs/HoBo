# Promoted from the README's prose gherkin blocks; every step drives
# services/reference-architecture.ts (the epic's real mocked boundary harness).
Feature: Contracts, policy and governance
  Gatekeeper composes contract, policy, obligation, cost, provenance, and
  conformance gates into deterministic deploy decisions that allow with
  obligations, enforce the deny ceiling, and fail closed on uncertainty.

  Scenario: Compatible deploy produces auditable approval obligations
    Given a production camp with mandatory contract, policy, obligation, cost, provenance, and conformance gates
    When the platform SRE asks Gatekeeper to verify a compatible deploy
    Then Gatekeeper allows the deploy with approval obligations and replayable evidence
    And every declared governance boundary reports a mocked decision with no live network calls

  Scenario: Mandatory governance cannot be bypassed
    Given a bindle-level policy pack that tries to disable mandatory contract gates
    When Gatekeeper evaluates the deploy against the yard deny ceiling
    Then the deny ceiling keeps mandatory gates enabled and Gatekeeper blocks the deploy

  Scenario: Policy uncertainty fails closed
    Given the policy engine and signed policy-pack registry are unavailable
    When Gatekeeper verifies the production deploy without a policy decision
    Then the deploy is denied with a fail-closed reason from the mocked policy boundary
