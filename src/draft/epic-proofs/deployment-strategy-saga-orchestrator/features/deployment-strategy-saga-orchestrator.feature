# Promoted from the README's vertical-slice gherkin and acceptance mapping;
# every step drives services/deployment-strategy-orchestrator.ts against the
# committed multi-cloud-shop fixture.
Feature: Per-service deployment strategy sagas
  Each multi-cloud-shop service declares its own rollout strategy; the saga
  orchestrator runs health-gated promotion from data-plane and provider
  signals and auto-rolls back regressions with event-sourced decisions.

  Scenario: Deploy multi-cloud-shop with mixed strategies to green
    Given each multi-cloud-shop service declares recreate, blue-green, canary, or progressive
    When the saga orchestrator runs health-gated promotion for every service
    Then every strategy promotes the reference app to green

  Scenario: Auto-roll back a seeded canary regression
    Given a seeded canary SLO regression on the multi-cloud-shop web service
    When the canary saga observes the regression at fifty percent traffic
    Then the rollout auto-rolls back with an event-sourced decision and the gateway returns to blue

  Scenario: Health-gate promotion from data-plane and provider signals
    Given healthy and provider-unhealthy signal scenarios for the web service
    When the saga orchestrator deploys the web service under each signal scenario
    Then healthy signals promote the rollout and unhealthy provider signals roll it back
