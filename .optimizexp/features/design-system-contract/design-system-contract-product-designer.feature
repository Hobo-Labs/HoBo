@optimizexp @ux @dx @persona:product-designer @interface:cli
Feature: Source-based visual token checks

  Scenario: The implemented palettes meet text contrast requirements
    When I run palette validation on the current source
    Then palette validation reports no issues

  Scenario: Unreadable text is reported with its source file
    When I run palette validation with unreadable text
    Then palette validation reports "site/src/styles/global.css"
    And palette validation reports "contrast"
    And palette validation reports "minimum is 4.5"
