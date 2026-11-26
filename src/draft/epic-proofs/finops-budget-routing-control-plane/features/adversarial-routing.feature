Feature: Hosting routing preserves hard requirements and evidence
  Scenario: A preferred host misses the latency ceiling
    Given a pinned hosting scenario
    When every candidate exceeds the declared latency ceiling
    Then the hosting decision denies before metric evaluation

  Scenario: A feasible dominated incumbent remains stable
    Given a pinned hosting scenario
    When a one-dollar improvement dominates a recently selected incumbent
    Then the hosting decision retains its feasible incumbent

  Scenario: A catalog digest cannot describe changed inputs
    Given a pinned hosting scenario
    When a quoted cost changes without updating its catalog digest
    Then the hosting parser rejects the stale evidence

  Scenario: Pure replay cannot authorize an external mutation
    Given a pinned hosting scenario
    When the hosting proposal is evaluated twice
    Then the hosting replay is identical and external effects remain unauthorized
