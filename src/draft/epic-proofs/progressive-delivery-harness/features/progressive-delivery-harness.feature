Feature: Progressive delivery through the Harness
  The Harness composes feature flags, policy-gated rollout, SLO gates,
  experiment analysis, and rollback compensation through mocked boundaries.
  The README's single release scenario is distilled here into the four
  Harness outcomes its reference code proves: promotion, SLO rollback,
  fail-closed flag evaluation, and escalation when automation cannot certify
  itself. Steps drive src/harness-reference.ts over the committed fixture.

  Scenario: Healthy canary promotes checkout-v2 through one audit stream
    Given the checkout-v2 Harness fixture with a fresh feature-flag ruleset
    When the Harness runs the healthy canary rollout
    Then the Harness ramps traffic through 10, 50, and 100 percent and promotes
    And the Harness experiment concludes ship within the same audit stream

  Scenario: SLO burn rolls the Harness canary back automatically
    Given the checkout-v2 Harness fixture with an SLO burn snapshot
    When the Harness runs the burning canary rollout
    Then the Harness resets traffic to zero and records the rollback obligation as satisfied

  Scenario: Stale rulesets and underpowered experiments fail the Harness closed
    Given the checkout-v2 Harness fixtures for a stale ruleset and an underpowered experiment
    When the Harness evaluates both degraded rollouts
    Then the stale ruleset holds the Harness rollout on the fail-safe default
    And the underpowered Harness experiment refuses to conclude

  Scenario: Stuck traffic and failed compensation escalate to a human
    Given the checkout-v2 Harness fixtures for a stuck split and a failing compensator
    When the Harness detects non-convergence and exhausted rollback compensation
    Then the Harness escalates both rollouts to needs-human instead of self-certifying
