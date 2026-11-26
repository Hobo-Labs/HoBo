Feature: {{name}} OpenFeature flag
  Scenario: primary surface follows the flag
    Given OpenFeature flag "{{flagKey}}" is on
    Then the {{name}} primary surface is visible
