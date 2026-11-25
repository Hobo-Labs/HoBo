@fleet
Feature: Audit
  The audit chain is verifiable end to end.

  Background:
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval
    And the developer's device "box" enrolls in "laptops" with a bootstrap token

  Scenario: The audit chain verifies against witnessed checkpoints
    When the authority checkpoints its audit chain and the witness co-signs it
    Then the auditor reads the entries and witnessed checkpoints from the authority
    And the chain verifies against the pinned trust record
    And the chain fails to verify once any one entry is altered
