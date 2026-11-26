@optimizexp @dx @ax @persona:product-app-developer @interface:cli
Feature: cli-help-and-doctor (product app developer)

  Scenario: hobo --help lists the doctor verb for product-app-developer
    When I run the hobo CLI with arguments "--help"
    Then the exit code is 0
    And stdout contains "Canonical verbs:"
    And stdout contains "doctor"
    And stdout contains "Report environment and portability hazards"

  Scenario: hobo doctor returns the real report for product-app-developer
    When I run the composed hobo CLI with arguments "doctor --offline --json"
    Then the exit code is 0
    And the stdout is a JSON envelope with the standard shape
    And the JSON envelope on stdout has "verb" equal to "doctor"
