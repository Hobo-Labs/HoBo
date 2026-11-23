@optimizexp @ux @persona:product-end-user @interface:web
Feature: Public site first impression

  Scenario: A visitor understands what HoBo does
    When I open the public site
    Then the public site title contains "HoBo"
    And the public site introduction contains "cheapest infrastructure"
    And the public site introduction contains "your policies"

  Scenario: A visitor can reach the getting-started guide
    When I open the public site
    Then the public site next action is "Get started"
    And the next action opens the getting-started guide
