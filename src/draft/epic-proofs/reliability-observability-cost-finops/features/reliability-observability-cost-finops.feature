Feature: Reliability, Observability and Cost reference slice
  The reliability reference architecture folds telemetry, SLO gates, FinOps
  budget guards, saga compensation, and golden chaos evidence into one
  deterministic simulation. Steps drive
  services/reliability-reference-architecture.ts.

  Scenario: Deploy burn creates a rollback obligation
    Given a deployment emitting trace-correlated telemetry and SLO samples
    When the deploy success SLO exhausts its reliability error budget
    Then the reliability policy gate returns rollback with an obligation
    And missing SLI data keeps the reliability gate fail-closed

  Scenario: Spend pressure degrades safely before runaway spend expands
    Given metered usage, credit headroom, and quota policy reliability fixtures
    When projected period spend crosses a cost availability tier
    Then the reliability quota policy allows degraded execution
    And sustained spend velocity trips the runaway-spend breaker while app traffic is unaffected

  Scenario: Partial deploy failure compensates only provisioned resources
    Given a deployment saga that provisioned network and database resources
    When the API resource fails across the saga no-go threshold
    Then reliability compensation destroys database before network
    And the Run Inspector exposes completed reliability replay evidence

  Scenario: Golden Suite and chaos evidence feed reliability status
    Given passing runtime-local and Camp Golden Suite targets
    When node-loss chaos preserves the steady-state invariant
    Then the reliability rollup keeps chaos evidence explicit and allows continue
    And a chaos blast-radius leak aborts the reliability experiment
