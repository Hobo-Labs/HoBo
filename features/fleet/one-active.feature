@fleet
Feature: One-active fleets in local mode
  The assignment register fails over and admits members safely.

  Scenario: A one-active fleet fails over to a healthy member
    Given a local one-active fleet "cache" of "c0,c1,c2"
    When the fleet ticks
    Then "c0" is the active member
    When "c0" reports QUOTA_EXHAUSTED and the fleet ticks
    Then the tick fails over to "c1"
    When the seal wait passes and the fleet ticks
    Then "c1" is the active member

  Scenario: A one-active fleet admits a new member through a membership epoch
    Given a local one-active fleet "cache" of "c0,c1,c2" with membership epochs
    When the fleet ticks twice
    Then the register's member set is "c0,c1,c2"
    When a new deploy configures "c0,c1,c2,c3" and the fleet ticks
    Then the tick admits "c3" in a decided membership epoch
    And the register's member set is "c0,c1,c2,c3"
    And "c0" is the active member
