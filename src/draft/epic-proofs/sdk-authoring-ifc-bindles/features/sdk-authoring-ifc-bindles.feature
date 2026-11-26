# Narrowing note: the README's runtime-primitive scenarios (durable
# workflow/step/actor surface) live in the hobo-runtime-ts-primitives
# technical proof and are not runnable from this package; these scenarios
# cover what services/sdk-authoring-reference-architecture.ts actually proves.
Feature: SDK and IfC authoring lower to one manifest
  An app author declares resources, handlers, XAA access, auth, topology, and
  Hobo Code DSL input; every authoring front door lowers to one deterministic
  hobo.manifest/v1 while guardrails surface narrowing, coverage, and scope
  problems before deploy.

  Scenario: IfC declarations lower to one deterministic manifest
    Given the sample Bindle authored through the IfC scenario fixture
    When the SDK authoring reference simulation lowers the declarations
    Then one deterministic hobo.manifest v1 is emitted for the authored Bindle
    And the generated IfC type surface is clean with no drift

  Scenario: Authoring guardrails surface before deploy
    Given the IfC guardrail inputs with unobserved, narrowed, and widened declarations
    When the SDK authoring guardrails evaluate the declarations
    Then collection coverage, permission narrowing, and XAA scope widening each fail closed
    And raw driver usage is marked as portability debt

  Scenario: Hobo Code DSL stays a lowering front door with parity
    Given the same Bindle authored in the Hobo Code DSL
    When the DSL lowers next to the TypeScript authoring path
    Then the DSL manifest is byte-identical to the TypeScript manifest
    And non-TypeScript parity requires a semantics annex instead of copied syntax
