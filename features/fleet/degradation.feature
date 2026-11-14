@fleet
Feature: Standalone degradation
  A member that cannot reach the bus keeps doing what it is already entitled to do.

  Scenario: With the bus down a device finishes its order and refuses new work
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval
    And the developer's device "box" runs held jobs in "laptops"
    When the developer submits the job "first" to "laptops" and the device starts running it
    And the bus goes down
    And the developer submits the job "second" to "laptops"
    And the running job finishes
    Then the job's SUCCEEDED receipt waits in the device's pending receipts
    And the device has not started "second"
    When the bus comes back
    Then the pending receipt is published exactly once
