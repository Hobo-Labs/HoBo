@optimizexp @dx @ax @persona:product-coding-agent @interface:cli
Feature: Find experience proof packages by audience

  Scenario: List user experience proofs as structured data
    When I run the experience inventory for user proofs as JSON
    Then the inventory lists real user experience packages

  Scenario: An unknown audience is rejected with available choices
    When I run the experience inventory for an unknown type
    Then the inventory reports the valid experience types
