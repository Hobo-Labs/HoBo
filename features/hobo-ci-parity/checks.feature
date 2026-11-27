Feature: Runner-less check parity with RelayRunner
  A relay job made only of HoBo check steps is completed by the relay with
  no runner. One scenario per gauntlet case; the case catalog is cases.json
  beside this file. A scenario tagged waits for the work package
  that builds it.

  @parity @C01 @t2 @t3
  Scenario: C01 A pull request title check runs with no runner and no minutes
    Given relay mode is on for "octo/app" with the allowed title types "feat, fix"
    And a relay job whose only step uses "hobo-labs/hobo/checks/pr-title"
    When a pull request titled "chore: tidy" queues it
    Then the relay completes the job as failed with the allowed types in its annotation
    And no runner took the job

  @parity @C02 @t2
  Scenario: C02 Linters run in a sandbox with no network and one result per tool
    Given a relay job whose only step uses "hobo-labs/hobo/checks/lint" with two tools
    When the relay answers the check job
    Then each tool ran in a HoBo sandbox with no network
    And the job carries one result per tool

  @parity @C03 @t1
  Scenario: C03 A broken runnerOrder is refused with the parser's sentence
    Given ".hobo/ci.json" holds a runnerOrder with no steps
    When "hobo ci route --github ubuntu-24.04" runs in that checkout
    Then it is refused with the parser's sentence
