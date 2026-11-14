@fleet
Feature: Transport sessions
  Two devices open a stream only with an authority-signed grant.

  Background:
    Given a fleet authority on the in-memory bus
    And the developer owns the many-active fleet "laptops" with owner approval
    And the developer's device "box" enrolls in "laptops" with a bootstrap token

  Scenario: A granted session carries a shell
    When the developer asks the authority for a shell session to the device
    Then the device authorises the grant from the developer's CLI
    And a shell command and its output cross the session encrypted end to end

  Scenario: A session without a valid grant is refused
    When the developer asks the authority for a forward session to the device
    Then the authority refuses it as fleet-policy
    When a shell grant is signed by a key the trust record does not name
    Then the device refuses that grant
    When the developer's genuine shell grant is presented by another peer
    Then the device refuses that grant
