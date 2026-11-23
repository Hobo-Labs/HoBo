@optimizexp @dx @ax @persona:product-app-developer @interface:cli
Feature: cli-product hobo CLI help, stub envelope, and unknown-verb handling

  Scenario: hobo --help lists the canonical verbs
    When I run the hobo CLI with arguments "--help"
    Then the exit code is 0
    And stdout contains "Start here:"
    And stdout contains "hobo new my-app -t api"
    And stdout contains "Canonical verbs:"
    And stdout contains "doctor"
    And stdout contains "deploy"
    And stdout contains "up"

  Scenario: hobo new --help shows real verb flags
    When I run the hobo CLI with arguments "new --help"
    Then the exit code is 0
    And stdout contains "-t todo|api|agent|fullstack"
    And stdout contains "--force"

  Scenario: hobo codegen --help shows real verb flags
    When I run the hobo CLI with arguments "codegen --help"
    Then the exit code is 0
    And stdout contains "--check"

  Scenario: hobo build --help shows real verb documentation
    When I run the hobo CLI with arguments "build --help"
    Then the exit code is 0
    And stdout contains "hobo build [global flags]"
    And stdout contains "wasm components"
    And stdout contains "Example:"

  Scenario: hobo dev --help lists verb-specific flags
    When I run the hobo CLI with arguments "dev --help"
    Then the exit code is 0
    And stdout contains "--once"
    And stdout contains "--port <port>"
    And stdout contains "--host <host>"

  Scenario: stub verb returns a non-deceptive JSON envelope
    When I run the hobo CLI with arguments "deploy --json"
    Then the exit code is 1
    And the stdout is a JSON envelope with the standard shape
    And the JSON envelope on stdout has "ok" equal to "false"
    And the JSON envelope on stdout has "status" equal to "not_implemented"
    And the JSON envelope on stdout has "code" equal to "HOBO_CLI_STUB"

  Scenario: unknown verb produces a typo suggestion and non-zero exit
    When I run the hobo CLI with arguments "deploi --json"
    Then the exit code is 2
    And the JSON envelope on stdout has "code" equal to "HOBO_CLI_USAGE"
    And stdout matches the pattern "Did you mean ..deploy"
    And the JSON envelope on stdout has a non-empty "remediation" array
