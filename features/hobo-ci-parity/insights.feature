Feature: Insight parity with RelayRunner
  What happened to each job, what it cost and how to make CI faster. One
  scenario per gauntlet case; the case catalog is cases.json beside this
  file. A scenario tagged @pending waits for the work package that builds
  it.

  @parity @I01 @t2
  Scenario: I01 Activity lists each job, where it ran and why, for 90 days
    Given route decisions journaled over the last 100 days
    When "hobo ci activity --since 90d --runner depot" runs
    Then it lists each matching job with its runner and the decision's reason
    And nothing older than 90 days

  @parity @I02 @t2
  Scenario: I02 History shows runs and jobs with step timings, time-outs and superseded runs
    Given run and job webhooks for a run that timed out and one that was superseded
    When the run history is read from the journal
    Then each job shows its step timings
    And the timed-out and superseded runs are marked

  @parity @I03 @t2
  Scenario: I03 Usage shows minutes against the included amount, burn, short jobs and what checks saved
    Given a month of stored runs and the owner's included minutes
    When "hobo ci usage" runs
    Then it shows minutes used against the included amount, the burn rate, short jobs and minutes saved by checks

  @parity @I04 @t1 @t2
  Scenario: I04 Performance compares workflows, jobs and runners, and each runner against ubuntu-latest
    Given stored runs on two runner types
    When "hobo ci performance" runs
    Then it compares workflows, jobs and runners
    And each runner is compared with the GitHub-hosted baseline

  @parity @I05 @t1 @t2
  Scenario: I05 Nine signals with thresholds, a breakdown and a trend
    Given stored runs over two weeks
    When the signals are read
    Then each of the nine signals has its threshold, a breakdown and a trend

  @parity @I06 @t1 @t3
  Scenario: I06 A failed job shows its step, a log excerpt and whether a re-run will help, with no model
    Given a failed job and the tail of its log
    When "hobo ci diagnose" runs for it
    Then it prints the failed step, the matched evidence and a re-run outlook
    And no model was called

  @parity @I07 @t2
  Scenario: I07 One OpenTelemetry trace per run attempt
    Given job and run webhooks for one run attempt delivered at different times
    When their spans are exported
    Then they share one trace id derived from the run id and attempt
