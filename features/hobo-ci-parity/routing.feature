Feature: Routing parity with RelayRunner
  The runner order decides where a job runs when HoBo CI claims it; no
  workflow job routes another. One scenario per gauntlet case; the case
  catalog is cases.json beside this file. A scenario tagged @pending waits
  for the work package that builds it.

  @parity @R01 @t2 @t3
  Scenario: R01 Relay mode claims a check job within five seconds and bills no minutes
    Given relay mode is on for "octo/app"
    And a check job labelled "hobo-relay" is queued for "octo/app"
    When the queued webhook reaches the relay
    Then the relay job is completed within 5 seconds of the webhook
    And the relay job ran on no runner and billed no minutes

  @parity @R02 @t1
  Scenario: R02 A job goes to the first runner in the order that can take it now
    Given the runner order of "octo/app" is "machine, depot, github"
    And a relay job for "octo/app" names these runner types:
      | type    | labels             |
      | machine | self-hosted        |
      | depot   | depot-ubuntu-24.04 |
      | github  | ubuntu-24.04       |
    And no machine is connected
    When the relay answers the relay job
    Then the relay job succeeds on "depot-ubuntu-24.04" from the "depot" step
    And the journaled decision passed over "machine" because "no_machine"

  @parity @R03 @t1
  Scenario: R03 A runner type the job did not name, or the order leaves out, is never used
    Given the runner order of "octo/app" is "machine, depot, github"
    And a relay job for "octo/app" names these runner types:
      | type      | labels            |
      | namespace | namespace-profile-default |
      | github    | ubuntu-24.04      |
    And a connected machine "m-1" with labels "self-hosted, Linux, X64" and 1 free slot
    When the relay answers the relay job
    Then the relay job succeeds on "ubuntu-24.04" from the "github" step
    And the journaled decision lists "namespace" as not in the runner order

  @parity @R04 @t1
  Scenario: R04 When nothing fits, the decision fails with the one-sentence reason
    Given the runner order of "octo/app" is "machine"
    And a relay job for "octo/app" names these runner types:
      | type    | labels      |
      | machine | self-hosted |
    And no machine is connected
    When the relay answers the relay job
    Then the relay job fails with a reason naming "machine"

  @parity @R05 @t1
  Scenario: R05 When machines are only busy the job waits on the busy step's label
    Given the runner order of "octo/app" is "machine"
    And a relay job for "octo/app" names these runner types:
      | type    | labels      |
      | machine | self-hosted |
    And a busy connected machine "m-1" with labels "self-hosted, Linux, X64"
    When the relay answers the relay job
    Then the relay job waits on "hobo-machine-m-1" from the "machine" step

  @parity @R06 @t1
  Scenario Outline: R06 Public repositories and forks never run on machines
    Given the runner order of "octo/app" is "machine, github"
    And a relay job for "octo/app" names these runner types:
      | type    | labels       |
      | machine | self-hosted  |
      | github  | ubuntu-24.04 |
    And a connected machine "m-1" with labels "self-hosted, Linux, X64" and 1 free slot
    And the relay job comes from <origin>
    When the relay answers the relay job
    Then the relay job succeeds on "ubuntu-24.04" from the "github" step
    And the journaled decision passed over "machine" because "<reason>"

    Examples:
      | origin                  | reason             |
      | a public repository     | public_repository  |
      | a fork's pull request   | fork_pull_request  |

  @parity @R06b @t1
  Scenario: R06b The fleet takes a public repository or a fork's pull request only when it isolates such jobs
    Given the runner order of "octo/public" is "fleet, github"
    And a relay job for "octo/public" names these runner types:
      | type   | labels       |
      | fleet  | hobo         |
      | github | ubuntu-24.04 |
    And the relay job comes from a public repository
    And the fleet is taking jobs but does not isolate them
    When the relay answers the relay job
    Then the relay job succeeds on "ubuntu-24.04" from the "github" step
    And the journaled decision passed over "fleet" because "needs_isolation"
    Given the fleet isolates each job
    When the relay answers the relay job
    Then the relay job succeeds on "hobo" from the "fleet" step

  @parity @R07 @t1 @t2 @pending
  Scenario: R07 GitHub-hosted runners are used while under the minutes limit with a two-hour runway
    Given the owner's measured Actions minutes are read by the billing reader
    When the minutes used pass the limit, or the burn would pass it within two hours
    Then the github step is passed over with "minutes_limit" or "minutes_runway"
    And when the minutes cannot be read, the github step is still used

  @parity @R08 @t1 @t2 @pending
  Scenario: R08 A provider is used while under its monthly spend limit, summed from the ledger
    Given the ledger holds this month's spend on depot
    When the spend reaches the depot spend limit
    Then the depot step is passed over with "spend_limit"
    And with no ledger entry the depot step is still used

  @parity @R09 @t1 @t2 @pending
  Scenario: R09 A provider that misses three jobs in thirty minutes is skipped, tried again with back-off and can be cleared
    Given depot missed three jobs within thirty minutes
    Then the depot step is passed over with "provider_unhealthy"
    And the health record survives a relay restart
    And a trial job is let through after the back-off
    And "hobo ci provider-health clear depot" clears it

  @parity @R10 @t2 @pending
  Scenario: R10 A job that lost its runner is retried at most twice and never twice for one delivery
    Given a job failed before its own steps ran
    When its workflow_run completed webhook is delivered twice
    Then the failed jobs are re-run once
    And no job is retried more than twice

  @parity @R11 @t1 @t2 @pending
  Scenario: R11 A job picks its own size and a runner type to try first
    Given a job asking for "size: 8" and "first: depot"
    When the relay job is answered
    Then the depot step is tried first with an 8 vCPU label

  @parity @R12 @t2 @pending
  Scenario: R12 A re-run of failed jobs is routed again when HoBo CI claims it
    Given a run whose job on a HoBo label failed
    When the failed jobs are re-run
    Then HoBo CI claims the job again and routes it with the facts of now

  @parity @R13 @t2
  Scenario: R13 A check job whose webhook never arrived is answered within two poll intervals
    Given the next webhook is lost
    And a check job labelled "hobo-relay" is queued for "octo/app"
    When two poll intervals pass
    Then the relay job is completed

  @parity @R14 @t2 @pending
  Scenario: R14 Each leg of a matrix job on a HoBo label is routed when HoBo CI claims it
    Given a workflow whose matrix job of three legs has runs-on set to a HoBo label
    When HoBo CI claims each leg
    Then each leg runs where the runner order sends it

  @parity @R16 @t2
  Scenario: R16 With the hosted relay down, a second node answers the check job
    Given two relay nodes and the hosted one is down
    And a check job labelled "hobo-relay" is queued for "octo/app"
    When the queued webhook is delivered
    Then the second node completes the relay job exactly once
