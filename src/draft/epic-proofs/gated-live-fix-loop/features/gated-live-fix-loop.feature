# Promoted from the README's vertical-slice gherkin; every step drives
# services/gated-live-fix-loop.ts against the committed simulation fixture.
Feature: Gated live-fix loop
  An SLO regression captures a failing trace, generates a fix candidate, and
  routes it through policy classification: low-risk fixes canary with
  auto-rollback, production fixes block on human approval, and every failing
  trace persists as a permanent regression test.

  Scenario: SLO regression drives a low-risk fix through canary with auto-rollback
    Given a staging SLO regression fixture with a captured failing trace
    When the gated live-fix loop classifies the fix as low-risk and starts a canary
    Then canary SLO regression triggers auto-rollback and the failing trace persists as a permanent regression test

  Scenario: Production fix blocks until approved
    Given the same incident classified in the production environment
    When the gated live-fix loop evaluates the production fix candidate
    Then human approval is required before any canary starts and the failing trace is retained
