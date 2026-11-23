@optimizexp @dx @persona:developer @interface:cli
Feature: Staged checks for a skill edit

  Scenario: A staged skill edit selects the mirror and source checks
    When I run staged-check selection for skill
    Then the staged gate command exits with 0
    And the staged gate output contains "source:guard"
    And the staged gate output contains "skills:mirror-check"
    And the staged gate output excludes "turbo run test"

  Scenario: An invalid base fails before selecting gates
    When I run staged-check selection with an invalid base
    Then the staged gate command exits with 2
    And the staged gate output contains "--base=missing-base is not a commit"
    And the staged gate output excludes "Changed files:"
