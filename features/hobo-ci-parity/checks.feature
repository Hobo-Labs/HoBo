Feature: Runner-less check parity with RelayRunner
  A relay job made only of HoBo check steps is completed by the relay with
  no runner. One scenario per gauntlet case; the case catalog is cases.json
  beside this file. A scenario tagged @pending waits for the work package
  that builds it.

  @parity @C01 @t2 @t3 @pending
  Scenario: C01 A pull request title check runs with no runner and no minutes
    Given relay mode is on for "octo/app" with the allowed title types "feat, fix"
    And a relay job whose only step uses "hobo-labs/hobo/checks/pr-title"
    When a pull request titled "chore: tidy" queues it
    Then the relay completes the job as failed with the allowed types in its annotation
    And no runner took the job

  @parity @C02 @t2 @pending
  Scenario: C02 Linters run in a sandbox with no network and one result per tool
    Given a relay job whose only step uses "hobo-labs/hobo/checks/lint" with two tools
    When the relay answers it
    Then each tool ran in a HoBo sandbox with no network
    And the job carries one result per tool

  @parity @C03 @t1 @t2 @pending
  Scenario: C03 A broken runnerOrder fails the relay job with the parser's sentence
    Given ".hobo/ci.json" holds a runnerOrder with no steps
    When a relay job for the repository is answered in job mode
    Then the relay job fails with the parser's sentence as its annotation
