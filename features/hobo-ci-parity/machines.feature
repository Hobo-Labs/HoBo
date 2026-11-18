Feature: Machine parity with RelayRunner
  A machine is a computer its owner connects so relay jobs can run on it.
  One scenario per gauntlet case; the case catalog is cases.json beside
  this file. A scenario tagged @pending waits for the work package that
  builds it.

  @parity @M01 @t2 @pending
  Scenario: M01 One command connects a machine, and once it stops the next decision skips it
    Given a clean machine with the hobo CLI and no checkout
    When "hobo ci machine connect" runs
    Then the machine is advertised and takes the next relay job it fits
    When the command is stopped
    Then within 60 seconds the next decision passes over the machine

  @parity @M02 @t2 @pending
  Scenario: M02 Each job gets a fresh one-job runner and the machine keeps no permanent runner
    Given a connected machine
    When two jobs run on it one after the other
    Then each ran on its own one-job runner
    And no runner stays registered once both are done

  @parity @M03 @t1
  Scenario Outline: M03 A machine must hold every label asked for, and self-hosted means any machine
    Given the runner order of "octo/app" is "machine, github"
    And a relay job for "octo/app" names these runner types:
      | type    | labels       |
      | machine | <asked>      |
      | github  | ubuntu-24.04 |
    And a connected machine "m-1" with labels "self-hosted, Linux, X64" and 1 free slot
    When the relay answers the relay job
    Then the relay job succeeds on "<runner>" from the "<step>" step

    Examples:
      | asked                  | runner             | step    |
      | self-hosted            | hobo-machine-m-1   | machine |
      | self-hosted, Linux, X64 | hobo-machine-m-1  | machine |
      | self-hosted, gpu       | ubuntu-24.04       | github  |

  @parity @M04 @t1 @t2 @pending
  Scenario: M04 A machine runs several jobs at once up to its slots
    Given a connected machine with 2 slots
    When three relay jobs that fit it are answered
    Then two route to the machine and the third does not

  @parity @M05 @t2 @pending
  Scenario: M05 A paused machine takes no new job and its running job finishes
    Given a connected machine running one job
    When "hobo ci machine pause" runs for it
    Then the next decision passes over it with "machine_paused"
    And its running job finishes
    When "hobo ci machine resume" runs for it
    Then the next relay job that fits routes to it

  @parity @M06 @t1 @t2 @pending
  Scenario: M06 A machine shared with anyone still needs its owner to read the repository
    Given a machine shared with "anyone"
    When a relay job from another member's repository the owner cannot read is answered
    Then the decision passes over the machine with "machine_not_shared"

  @parity @M07 @t2 @pending
  Scenario: M07 Machine jobs run in a fresh container by default on Linux
    Given a connected Linux machine with default settings
    When a job runs on it
    Then the job ran in a container started for it and removed after it

  @parity @M08 @t2 @pending
  Scenario: M08 A machine signs its adverts with its own key, and a takeover raises an event
    Given a connected machine with its advert key
    When another connect claims the same machine
    Then a "machine.taken_over" event is sent
    And adverts signed with the old key are refused

  @parity @M09 @t2 @pending
  Scenario: M09 Removing a machine takes it out of the next decision
    Given a connected machine
    When "hobo ci machine remove" runs for it
    Then the next decision does not consider it

  @parity @M10 @t2 @pending
  Scenario: M10 An existing self-hosted runner is adopted with no change on the machine
    Given a self-hosted runner already registered on the organisation
    When "hobo ci runners adopt" runs for it
    Then the runner gets one unique label through the runner-labels API
    And the next relay job that names it routes to that label

  @parity @M11 @t1
  Scenario: M11 The runner program is pinned and checksum-verified
    When the pinned runner download is read for each architecture
    Then each names one pinned runner version and its own SHA-256 checksum

  @parity @M12 @t2 @pending
  Scenario: M12 A macOS machine takes a job
    Given a connected macOS machine
    When a relay job naming macOS is answered
    Then the job runs on the macOS machine

  @parity @M13 @t1 @pending
  Scenario: M13 One-job credentials are checked before use and the CLI's secrets never reach job steps
    Given a one-job runner configuration for a connected machine
    Then a configuration that fails its check is refused before the runner starts
    And the job's environment holds none of the CLI's tokens
