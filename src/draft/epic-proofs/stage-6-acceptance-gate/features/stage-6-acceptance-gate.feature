Feature: Stage-6 acceptance gate
  The scripted Stage-6 drill closes v1 GA readiness: six release-criteria
  checks (canary auto-rollback, plan-time cost tolerance, DR RTO, dashboard
  audits, governance evidence, prior gates S0-S5 green per ADR-0063) plus a
  complete v1 GA checklist, with adversarial fixtures failing the gate.

  Scenario: Green fixture closes v1 GA readiness
    Given the mocked Stage-6 green drill fixture with canary, FinOps, DR, dashboard, governance, and prior-gate evidence
    When the Stage-6 acceptance drill runs in CI
    Then all six Stage-6 release-criteria checks pass
    And prior gates S0 through S5 re-run green per ADR-0063
    And the Stage-6 evidence attaches to acceptance record "S6-01" with the v1 GA checklist complete
    And every Stage-6 mocked boundary pact verifies

  Scenario: DR rebuild exceeding the 15 minute RTO fails the gate
    Given the adversarial Stage-6 fixture "drRtoExceeded"
    When the Stage-6 acceptance drill evaluates the adversarial fixture
    Then the Stage-6 gate fails on check "dr-rebuild-rto"
    And no Stage-6 acceptance evidence is attached

  Scenario: Plan-time cost outside tolerance fails the gate
    Given the adversarial Stage-6 fixture "costOutOfTolerance"
    When the Stage-6 acceptance drill evaluates the adversarial fixture
    Then the Stage-6 gate fails on check "plan-time-cost-tolerance"
    And no Stage-6 acceptance evidence is attached

  Scenario: Governance bypass fails the gate
    Given the adversarial Stage-6 fixture "governanceBypass"
    When the Stage-6 acceptance drill evaluates the adversarial fixture
    Then the Stage-6 gate fails on check "governance-evidence"
    And no Stage-6 acceptance evidence is attached
