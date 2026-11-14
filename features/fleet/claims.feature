@fleet
Feature: Claims
  Only a claim the dispatcher can verify reaches an order.

  Background:
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval
    And the developer owns the many-active fleet "elsewhere" with owner approval
    And the device "hub" enrolled in "laptops" as a dispatcher
    And the device "victim" enrolled in "laptops" as an executor
    And the device "stranger" enrolled in "elsewhere" as an executor
    And "hub" offers the job "build-1" in "laptops"

  Scenario: A forged claim is discarded
    When "stranger" signs a claim on "build-1" that names "victim"
    Then the dispatcher's claim rules discard it
    And a report of it is refused as evidence-invalid
    And "victim" is ACTIVE in the registry

  Scenario: A signed claim from outside the fleet is reported
    When "stranger" signs a claim on "build-1" in its own name
    Then the dispatcher's claim rules find it not-entitled
    When "hub" reports the claim to the authority
    Then "stranger" is SUSPENDED for claim-not-entitled
    And "victim" is ACTIVE in the registry
