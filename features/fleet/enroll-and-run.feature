@fleet
Feature: Enroll a device and run work
  A device enrolls itself with proof of possession and runs work its fleet policy allows.

  Background:
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval

  Scenario: A device enrolls with a single-use bootstrap token and runs work
    When the developer's device "box" enrolls in "laptops" with a bootstrap token
    Then the device is ACTIVE in the registry
    And the bootstrap token cannot enroll a second device
    When the device starts and the developer submits the job "echo hello" to "laptops"
    Then the job reaches a SUCCEEDED receipt from the device

  Scenario: A device enrolls through the person's browser approval
    When the developer's device "laptop" enrolls in "laptops" through the developer's browser approval
    Then the device is ACTIVE in the registry
    When the device starts and the developer submits the job "echo hello" to "laptops"
    Then the job reaches a SUCCEEDED receipt from the device

  Scenario: A device enrolls with a workload identity token
    Given the fleet "ci" trusts workload identities of "acme/app"
    When a CI runner "runner" enrolls in "ci" with its workload identity token
    Then the device is ACTIVE in the registry as an EPHEMERAL device
    And the same workload token cannot enroll another runner

  Scenario: Dual-control approval admits a pending device
    Given alice owns the many-active fleet "prod" with dual-control approval
    When the device "prod-box" enrolls in "prod" with a bootstrap token from alice
    Then the device is PENDING in the registry
    When alice approves the device's key
    And alice tries to accept the device herself
    Then the acceptance is refused by the dual-control rule
    When bob accepts the device
    Then the device is ACTIVE in the registry

  Scenario: A sponsor declares a backend into a fleet
    Given the developer owns the many-active fleet "caches" with owner approval
    When the developer declares the backend "redis" into "caches"
    Then the backend is ACTIVE in the registry under its sponsored member id
    And a second member named "redis" in "caches" is refused as name-taken
