Feature: S2 stage gate — first cloud and Yard
  The Stage-2 gate closes as a scripted drill over examples/hello-bindle:
  governed deploy, Yard kill/resume within the NFR-009 budget, saga
  compensation in reverse-dependency order, Gatekeeper blocks with
  explainable evidence, and a replayable deployment timeline.

  Scenario: Governed deploy lands hello-bindle and serves traffic
    Given the pinned S2 hello-bindle stage-gate drill contract
    When the governed hello-bindle deploy runs through the Gatekeeper
    Then hello-bindle serves live traffic at the drill's sandbox URL
    And the full five-arm S2 stage-gate drill closes green

  Scenario: Yard killed mid-deploy resumes within the NFR-009 budget
    Given a hello-bindle deploy event log with the Yard killed mid-deploy
    When the Yard resumes the deploy from the append-only event log
    Then the hello-bindle resume completes within the 30 second NFR-009 budget

  Scenario: Seeded provisioning failure compensates in reverse-dependency order
    Given a seeded provisioning failure at resource "service.hello-bindle"
    When the hello-bindle deployment saga compensates the failure
    Then realized hello-bindle resources are destroyed in reverse-dependency order

  Scenario: Gatekeeper blocks an unsafe promotion with explainable evidence
    Given an unsafe hello-bindle Delta promotion with consumer-producer skew
    When the S2 Gatekeeper evaluates the unsafe promotion
    Then the unsafe promotion is blocked with an event-sourced explainable reason
    And a hello-bindle deploy that bypasses the Gatekeeper is rejected with code "gatekeeper.bypassed"
