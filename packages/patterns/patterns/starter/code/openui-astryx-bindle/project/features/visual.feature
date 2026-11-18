Feature: Primary visual surface
  OpenUI-generated Bindle UI linked to OpenFeature flag app.visual.primary.
  Loop: generate → edit → lock → evidence for the OpenUI starter.

  @openfeature:app.visual.primary
  Scenario: Primary surface renders with step rail and is lockable
    Given the OpenFeature flag "app.visual.primary" is enabled
    When the agent opens the OpenUI draft
    Then the draft shows data-testid "steps" with generate done and edit current
    And the user applies an in-context edit "ready"
    And the visual is locked as an intermediary artifact
    Then the agent browser validates data-testid "primary"
    And the locked card shows data-testid "seal"
    And the evidence triple is emitted for this scenario
