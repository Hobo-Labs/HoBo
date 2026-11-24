@fleet
Feature: Work trust classes against device classes
  Own, organisation and untrusted work reach only the devices and sandbox tiers their policy allows.

  Background:
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval

  Scenario: Own work runs on a personal device
    Given the developer's personal device "laptop" with an S1 sandbox enrolled through browser approval
    When the device starts and the developer submits the job "echo own" to "laptops"
    Then the job reaches a SUCCEEDED receipt from the device
    And the receipt names trust class OWN in sandbox tier S1_CONTAINER

  Scenario: Organisation work runs on a dedicated device
    Given the developer's dedicated device "builder" with an S3 sandbox enrolled with a bootstrap token
    When the device starts and alice submits the job "echo org" to "laptops"
    Then the job reaches a SUCCEEDED receipt from the device
    And the receipt names trust class ORG in sandbox tier S3_MICROVM

  Scenario: Untrusted work never runs on a personal device
    Given the developer's personal device "laptop" with an S1 sandbox enrolled through browser approval
    And the device "hub" enrolled in "laptops" as a dispatcher
    When "hub" offers fork work "pr-7" in "laptops"
    Then the personal device derives trust class UNTRUSTED for it
    And the sandbox table says never for UNTRUSTED work on a PERSONAL device
    And a claim by the personal device on it is not entitled to an order
