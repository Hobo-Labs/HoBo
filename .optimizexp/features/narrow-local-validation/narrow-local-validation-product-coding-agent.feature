@optimizexp @dx @ax @persona:product-coding-agent @interface:cli
Feature: Narrow staged validation

  Scenario: A staged package edit selects that package's tests
    When I run staged-check selection for package
    Then the staged gate command exits with 0
    And the staged gate output contains "--filter=./packages/cli"
    And the staged gate output excludes "--filter=./packages/hobo"

  Scenario: An empty index needs no checks
    When I run staged-check selection for empty
    Then the staged gate command exits with 0
    And the staged gate output contains "nothing to validate for this scope"
