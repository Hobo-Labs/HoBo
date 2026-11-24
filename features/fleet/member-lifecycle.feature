@fleet
Feature: Member lifecycle
  Members are locked on a clone, refreshed safely, revoked and rotated.

  Background:
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval
    And the developer's device "box" enrolls in "laptops" with a bootstrap token

  Scenario: A cloned device is locked and then unlocked by a person
    Given a copy of the device's key directory is taken
    When the device and its copy both start and refresh their credentials
    Then the device is LOCKED in the registry
    And the agent logged that the member was locked
    When the developer unlocks the device
    Then the device is ACTIVE in the registry

  Scenario: A lost refresh response does not lock the device
    Given the authority's answers to the device's next two credential refreshes are lost
    When the device starts
    Then the device still holds generation 0 and its pending refresh nonce
    When the device stops and a new agent starts on the same key directory
    Then the device holds generation 1 with no pending refresh nonce
    And the device is ACTIVE in the registry

  Scenario: A revoked member is refused at ranking, orders and the bus
    When the developer revokes the device
    Then the device is REVOKED in the registry
    And a claim the device signs is not entitled to an order
    And the device's credential refresh is refused as member-revoked, so it gets no bus ticket

  Scenario: A device rotates its key bundle
    When the device rotates its operational keys and registers key bundle 2
    Then the registry holds key bundle 2 for the device
    And a claim signed with the device's new SIGN key is valid
    And a claim signed with the device's retired SIGN key is discarded
