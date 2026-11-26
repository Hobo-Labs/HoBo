Feature: Operators and SRE Crew reference slice
  The Crew reference architecture composes the SRE operator, endpoint monitor,
  policy gate, live-fix gateway, human approval, runaway guard, and DR replay
  boundary into deterministic incident flows. Steps drive
  services/crew-reference-architecture.ts over its committed scenario fixtures.

  Scenario: Provider degradation is remediated through a gated canary
    Given the Crew endpoint monitor reports high API SLO burn
    When the SRE Crew operator diagnoses provider degradation
    Then one Crew incident opens and policy allows a canary remediation
    And the Crew live-fix completes and replay evidence publishes

  Scenario: Production contract skew waits for approval
    Given a Crew compatibility gate failure between a producer and consumer
    When the SRE Crew operator proposes a dual-publish shim
    Then the Crew action waits for operator-console approval before any live-fix call
    And an approved Crew decision resumes the canary and resolves the incident

  Scenario: Ambiguous self-caused drift escalates
    Given a Crew drift signal that may stem from prior remediation
    When the Crew taxonomy cannot classify the drift safely
    Then the Crew runaway guard opens a circuit and denies further writes
    And the Crew requests human handoff without another remediation write

  Scenario: DR failover proves fencing and replay before traffic shift
    Given a production region loss detected by the Crew
    When the Crew DR runbook evaluates regional failover
    Then Crew fencing, RPO honesty, and replicated log replay are certified
    And the certified Crew evidence precedes the traffic shift
