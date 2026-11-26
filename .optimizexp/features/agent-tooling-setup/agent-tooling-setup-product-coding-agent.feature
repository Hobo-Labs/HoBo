@optimizexp @ax @dx @persona:product-coding-agent @interface:cli
Feature: Zero-key agent setup

  Scenario: Setup help shows the zero-key path
    When I run agent setup help
    Then the agent setup command exits with 0
    And the agent setup output contains "--no-gbrain"
    And the agent setup output contains "AUTH.md"

  Scenario: A missing agent name produces actionable usage
    When I run agent setup without an agent name
    Then the agent setup command exits with 2
    And the agent setup output contains "missing value for --agent"
    And the agent setup output contains "Usage:"

  Scenario: An unconfigured optional provider cannot start
    When I run the optional gbrain launcher without a provider
    Then the agent setup command exits with 1
    And the agent setup output contains "no embedding provider configured"
    And the agent setup output contains "gbrain init --pglite"
    And the optional server was not started
