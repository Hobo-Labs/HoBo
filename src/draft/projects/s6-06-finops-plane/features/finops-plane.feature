Feature: FinOps plane

  Plan-time cost estimates, budget deploy gates, and showback reconciliation
  for the s6-06 FinOps plane (HOBO-661 / FR-070 / NFR-012). Personas: the
  application developer running `hobo plan`, the FinOps lead owning budgets,
  and the platform engineer reconciling showback.

  Scenario: hobo plan returns projected cost from provider cost.json
    Given a capability manifest cost.json and a deployment plan usage profile
    When the FinOps plane estimates plan cost
    Then the estimate lands within the tolerance of the recorded actual spend fixture

  Scenario: Hard budget breach blocks deploy
    Given a camp hard budget below the projected plan cost
    When the deploy gate evaluates the plan estimate against policy
    Then the gate denies the deployment

  Scenario: Showback reconciles against recorded spend
    Given meter.UsageRecorded events in the event log
    When showback aggregates tenant, camp, and bindle actuals
    Then the showback total matches the MeteringView total cost
