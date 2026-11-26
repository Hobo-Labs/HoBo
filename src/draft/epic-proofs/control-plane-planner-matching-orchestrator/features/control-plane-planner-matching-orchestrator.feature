# Promoted from the README's prose gherkin blocks; every step drives
# services/control-plane-reference-architecture.ts (the epic's real simulation).
Feature: Control plane planner, matching, and orchestrator
  The Planner resolves Bindles into deterministic DeploymentPlans, the
  Orchestrator converges Sets through resource actors, drift and partial
  realization fail closed, and self-host bootstrap hands identity over exactly
  once — all through mocked Pact boundaries.

  Scenario: Plan a Bindle into replayable provider decisions
    Given a collected manifest and registered Resource Definitions in the planner fixture
    When the Planner resolves the checkout Bindle for prod
    Then it emits a deterministic DeploymentPlan with matching decisions and zero live network calls

  Scenario: Promote a Delta into a Set and converge resources
    Given an approved deployment Delta for the checkout Set
    When the Orchestrator applies the Set through resource actors
    Then ResourceActors reconcile in dependency order through mocked executor and driver boundaries

  Scenario: Recover from drift and partial realization
    Given provider drift and a created-but-not-in-state partial failure
    When the level-triggered reconcile loop runs against the drifted resources
    Then the reference rolls back with the orphan recorded and blocks double-spend dispatch

  Scenario: Seed a Yard and hand over identity
    Given a local seed Yard with one short-lived operator credential
    When the real Yard identity broker becomes ready
    Then the seed event log imports, the seed credential retires, and duplicate bootstrap is blocked
