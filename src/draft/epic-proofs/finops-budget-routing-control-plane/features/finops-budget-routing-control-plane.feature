Feature: FinOps budget routing control plane
  The router composes FinOps, policy, observability, and adapter evidence into
  deterministic decisions without leaking provider-specific execution details
  into the core.

  Scenario: Provider-neutral dry run
    Given a ResourceIntent with budget, capability, and routing objective
    When the control plane evaluates abstract candidates
    Then it emits a DecisionGraph and backend-neutral ActionPlan

  Scenario: Governed user metrics
    Given a user metric contract
    When it references raw telemetry directly
    Then parsing fails before routing begins

  Scenario: Constraint-first Pareto routing
    Given valid, invalid, and dominated candidates
    When the router filters and ranks them
    Then invalid candidates receive no metric vectors
    And preference weights select only within the Pareto frontier

  Scenario: Stability-controlled feedback
    Given recent routing history
    When a new candidate improves by less than the stability threshold
    Then the current placement is retained
    And feedback produces a proposal rather than mutating metrics or policy
