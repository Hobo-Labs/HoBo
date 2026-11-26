Feature: Contracts Effects + Visible Resiliency (ADR-0136)
  As a contract author and Gatekeeper consumer
  I want EffectSpec and ResilienceProfile on BoundaryContracts
  So testing isolates pure work, mocks domain I/O, and never retries policy denials

  Scenario: Pure contract isolates with zero infrastructure
    Given a BoundaryContract with effects purity pure
    When the contract-harness builds effect isolation
    Then isolationMode is zero-infra and mocks is empty

  Scenario: Domain effects drive automatic mocks
    Given a BoundaryContract with domains network and externalCall
    When the harness creates domain mocks
    Then each domain has a stub handler

  Scenario: Effect widening is breaking
    Given a pure contract revision 1.0.0
    When the next revision adds network domain effects
    Then checkCompatibility returns breaking with code effect-widened

  Scenario: Never retry policy.Decided
    Given a ResilienceProfile with deterministic retry
    When the applicator receives a policy.Decided denial
    Then attempts is 1 and retried is false

  Scenario: EffectManifest export and capture
    Given a declared EffectSpec on a contract
    When EffectManifest is exported and EffectTracer records declare+invoke
    Then inspection returns the same facts without re-execution

  Scenario: Gatekeeper surfaces effects and resiliency
    Given a candidate contract with effects and ResilienceProfile
    When evaluateGatekeeper runs
    Then effectSummaries are present and reasons may include gate effects or resilience
