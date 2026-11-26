Feature: Mapping styles and Planner resolution
  The S4-04 reference slice proves that one unchanged shop Bindle deploys
  through whole-app, per-tier, and per-binding Camp mappings, and that the
  Planner's prefer/require negotiation degrades or fails closed. Steps drive
  src/mapping-styles-planner-resolution.ts and its promoted upstream proofs.

  Scenario: Same Bindle resolves to AWS or Azure by mapping edit only
    Given the reference shop Bindle with mapping-style Camps
    When the Camp mapping defaultProvider switches between aws and azure
    Then mapping-style deployment.Planned selects the mapped provider for every shop resource

  Scenario: Each mapping style deploys the reference shop app
    Given whole-app, per-tier, and per-binding shop Camp mappings
    When the Planner resolves each mapping style with the single-provider objective
    Then each mapping style plan covers shop.db, shop.api, and shop.web with rationale

  Scenario: Required capability miss fails the plan closed
    Given an azure shop mapping that requires database.ha
    When the Planner negotiates against the azure manifest without ha
    Then mapping-style deployment.PlanRejected carries capability.require.unsatisfied

  Scenario: Preferred capability miss degrades with a planWarning
    Given an azure shop mapping that prefers database.ha
    When the Planner negotiates the preferred capability against the azure manifest
    Then mapping-style deployment.Planned succeeds with a capability.prefer.degraded planWarning
