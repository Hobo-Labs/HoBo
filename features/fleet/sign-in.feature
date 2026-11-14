@fleet
Feature: Fleet sign-in
  A person signs in to the fleet authority through the organisation's identity provider.

  Background:
    Given a fleet authority on the in-memory bus

  Scenario: A person signs in with a browser on the loopback redirect
    When the developer signs in with a browser on the loopback redirect
    Then the approval page showed the four fingerprint words of the sign-in key
    And the person credential authenticates the developer with the sign-in key only

  Scenario: A person signs in with a device code and the poll answers once after approval
    When the developer signs in with a device code
    Then the poll before approval answered sign-in-pending
    And the person credential authenticates the developer with the sign-in key only
    And polling again after the credential was issued is refused as conflict
