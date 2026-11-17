Feature: Routing parity with RelayRunner
  The runner order decides where each relay job runs. One scenario per
  gauntlet case; the case catalog is cases.json beside this file. A scenario
  tagged @pending waits for the work package that builds it.

  @parity @R01 @t2 @t3
  Scenario: R01 Relay mode answers a relay job within five seconds and bills no minutes
    Given relay mode is on for "octo/app"
    And a relay job labelled "hobo-relay" is queued for "octo/app"
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

  @parity @R04 @t2 @t3
  Scenario: R04 When nothing fits, the relay job fails with the reason and the job behind it is skipped
    Given relay mode is on for "octo/app" with the runner order "machine"
    And a relay job for "octo/app" names only "machine" and no machine is connected
    And a job "build" needs the relay job
    When the relay job is answered in relay mode
    Then the relay job fails with the one-sentence reason as an annotation
    And GitHub skips the job "build"

  @parity @R05 @t2
  Scenario: R05 When machines are only busy the job waits on the busy step's label, and a cancel frees it
    Given relay mode is on for "octo/app" with the runner order "machine"
    And every machine that fits the relay job is busy
    When the relay job is answered in relay mode
    Then the relay job succeeds with outcome "waiting" and the busy step's label as its runner
    And the job behind it queues on that label
    When the run is cancelled
    Then the queued job leaves the queue and holds no slot

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

  @parity @R06b @t1 @t2
  Scenario: R06b The fleet takes a public repository or a fork's pull request only when it isolates such jobs
    Given relay mode is on for the public repository "octo/public" with the runner order "fleet, github"
    And the fleet is taking jobs but does not isolate them
    When a public repository's relay job is answered in relay mode
    Then the relay node's journaled decision passed over "fleet" because "needs_isolation"
    When the fleet isolates each job
    Then the next public relay job routes to the fleet

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
  Scenario: R11 A job picks its own size and a runner type to try first through relay inputs
    Given a relay job with the inputs "size: 8" and "first: depot"
    When the relay job is answered
    Then the depot step is tried first with an 8 vCPU label

  @parity @R12 @t2 @pending
  Scenario: R12 A re-run of failed jobs returns to its label, and a reroute decides again
    Given a run whose routed job failed
    When the failed jobs are re-run
    Then the job queues on the label it had
    When "hobo ci rerun --reroute" runs for the run
    Then the relay job is answered again with the facts of now

  @parity @R13 @t2
  Scenario: R13 A relay job whose webhook never arrived is answered within two poll intervals
    Given the next webhook is lost
    And a relay job labelled "hobo-relay" is queued for "octo/app"
    When two poll intervals pass
    Then the relay job is completed

  @parity @R14 @t2 @t3 @pending
  Scenario: R14 One relay output routes a three-leg matrix
    Given a workflow whose matrix job of three legs needs one relay job
    When the relay job is answered
    Then all three legs run on the relay's runner

  @parity @R15 @t3 @pending
  Scenario: R15 Job mode routes a job with no relay reachable
    Given a repository with the job-mode relay workflow and no relay deployed
    When a run starts
    Then the relay job decides on a GitHub-hosted runner and the job runs where it said

  @parity @R16 @t2
  Scenario: R16 With the hosted relay down, a second node answers the relay job
    Given two relay nodes and the hosted one is down
    And a relay job labelled "hobo-relay" is queued for "octo/app"
    When the queued webhook is delivered
    Then the second node completes the relay job exactly once
