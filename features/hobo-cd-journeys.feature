# Promotes the journey semantics of the frozen proofs
# src/draft/exp-proofs/dx/{devops-canary-rollout,gitops-ci,sre-drift-remediation}-journey-contract
# (plan 0024 §3) into shipped acceptance features; the proofs stay unedited.
@hobo-cd
Feature: HoBo.CD delivery journeys
  As a team delivering a Bindle through dev, staging and prod
  I want promotion to follow lineage, windows, verification and approvals
  So that unverified Freight never skips an environment and a bad canary rolls back on its own

  Background:
    Given a CD pipeline dev → staging → prod

  Scenario: dev → staging → prod lineage
    Given Freight "shop@1.4.0" is recorded
    When a human promotes "shop@1.4.0" to "prod"
    Then the promotion is refused with "lineage-unsatisfied"
    When "shop@1.4.0" is promoted to "dev" and verifies PASS
    And "shop@1.4.0" is promoted to "staging" and verifies PASS
    And a human promotes "shop@1.4.0" to "prod"
    Then the "prod" Camp runs "shop@1.4.0"

  Scenario: canary auto-rollback on a Mann–Whitney failure
    Given "shop@1.4.0" runs in "staging"
    And Freight "shop@1.5.0" is promoted to "staging" as a canary
    When the canary error rate is significantly worse than baseline at MEDIUM sensitivity
    Then canary verification is FAIL
    And the "staging" Camp rolls back to "shop@1.4.0"
    And "shop@1.5.0" is not qualified in "staging"

  Scenario: a canary that is no worse than baseline passes
    Given "shop@1.4.0" runs in "staging"
    And Freight "shop@1.5.0" is promoted to "staging" as a canary
    When the canary error rate matches baseline at MEDIUM sensitivity
    Then canary verification is PASS
    And "shop@1.5.0" is qualified in "staging"

  Scenario: a canary with no data fails closed
    Given Freight "shop@1.5.0" is promoted to "staging" as a canary
    When the health source returns no canary data
    Then canary verification is FAIL

  Scenario: freeze hold and resume
    Given a canary rollout of "shop@1.5.0" in "prod" behind window "prod-hours"
    And the rollout has reached 25 percent
    When window "prod-hours" freezes
    And the rollout reaches its next stage boundary
    Then the rollout holds at 25 percent
    When window "prod-hours" opens again
    And the rollout reaches 2 more stage boundaries
    Then the rollout is at 100 percent

  Scenario: promotion requested during a freeze waits for the window
    Given "shop@1.4.0" has passed verification in "staging"
    And window "prod-hours" freezes
    When a human promotes "shop@1.4.0" to "prod"
    Then the promotion is awaiting its window

  Scenario: hotfix approval
    Given Freight "shop@1.4.1-hotfix" is recorded
    When an operator approves "shop@1.4.1-hotfix" for "prod" for 72 hours
    And a human promotes "shop@1.4.1-hotfix" to "prod"
    Then the "prod" Camp runs "shop@1.4.1-hotfix"
    And an approval for 73 hours is refused
    When 73 hours pass
    And a human promotes "shop@1.4.1-hotfix" to "prod"
    Then the promotion is refused with "lineage-unsatisfied"

  Scenario: drift remediation
    Given "shop@1.4.0" runs in "prod"
    When the "prod" target drifts from its desired Set
    Then the reconciler remediates the drift by re-applying the Set
    And the "prod" Camp runs "shop@1.4.0"

  Scenario: agent proposal
    Given "shop@1.4.0" has passed verification in "staging"
    When an agent promotes "shop@1.4.0" to "prod"
    Then a proposal is recorded and nothing is applied to "prod"

  Scenario: the proposing agent cannot approve its own proposal
    Given "shop@1.4.0" has passed verification in "staging"
    When an agent promotes "shop@1.4.0" to "prod"
    Then the proposing agent cannot approve the proposal
    And a different human can approve the proposal

  Scenario: adopted drift is not healed backward
    Given "shop@1.4.0" runs in "prod"
    When the "prod" target drifts from its desired Set
    And the drift is adopted as desired state "shop@1.4.0+hotpatch"
    Then reconciling "prod" converges without remediation
    And the "prod" Camp runs "shop@1.4.0+hotpatch"

  Scenario: preview lifecycle
    Given a preview of "shop@1.5.0" with a TTL of 1 hour
    When 59 minutes pass
    Then the preview is live
    When 1 more minute passes
    Then the preview has expired and is removed

  Scenario: GitOps publisher
    Given a GitOps publisher for "prod"
    When the desired Set is published
    Then the Camp is converging, not converged
    When the GitOps engine syncs the published revision
    Then the Camp is converged
