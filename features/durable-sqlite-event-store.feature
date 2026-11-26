Feature: Portable SQLite EventStore and durable actor journal
  As a Camp runtime
  I want SQLite-backed durability with fencing and atomic effects
  So that aggregates and projections survive restart without multi-writer races

  Scenario: Replay aggregate after runtime restart
    Given a durable EventStore partition with one stream head
    When an aggregate appends facts under expectedSeq and fenceToken
    And the runtime closes and reopens the same partition file
    Then the stream revision and positions match the pre-restart head
    And fold state equals live fold state

  Scenario: Reject stale actor after lease transfer
    Given a stream with owner_epoch set by fenceToken 5
    When a holder appends with fenceToken 3 and correct expectedSeq
    Then the append fails with STALE_FENCE
    And the stream head is unchanged

  Scenario: Atomically create an event and actor signal
    When a durable commit stages one domain event and one actor-signal effect
    Then both rows exist after commit
    And a forced conflict before commit leaves neither row

  Scenario: Resume durable projection after crash
    Given a subscription checkpoint at position P
    When the worker restarts without advancing the checkpoint
    Then readAll after P replays unprocessed events
    And checkpoint regression is rejected

  Scenario: Fire durable timer once after restart
    Given a durable timer due in the past with idempotency key T
    When the runtime claims due timers after reopen
    Then the timer fires once and fired_at is set
    And a second claim does not redeliver the same timer
