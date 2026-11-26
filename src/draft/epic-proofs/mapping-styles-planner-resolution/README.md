# Mapping Styles + Planner Resolution (HOBO-640)

Epic draft POC for S4-04: three camp mapping styles, Planner `prefer`/`require` negotiation, multi-provider objective rationale on `deployment.Planned`, and inert `.with(...)` for non-resolved providers.

Linear: [HOBO-640](https://linear.app/quickdeploy-ai/issue/HOBO-640)

## BDD scenarios

```gherkin
Feature: Provider resolution by mapping style

  Scenario: Same Bindle resolves to AWS or Azure by mapping edit only
    Given a reference shop Bindle
    When the Camp defaultProvider switches between aws and azure
    Then deployment.Planned selects the mapped provider for every resource

  Scenario: Each mapping style deploys the reference app
    Given whole-app, per-tier, or per-binding Camp mappings
    When the Planner runs with single-provider objective
    Then deployment.Planned covers shop.db, shop.api, and shop.web with rationale

  Scenario: Required capability miss fails closed
    Given azure mapping and require database.ha
    When azure manifest lacks ha
    Then deployment.PlanRejected carries capability.require.unsatisfied

  Scenario: Preferred capability miss degrades with planWarning
    Given azure mapping and prefer database.ha
    When azure manifest lacks ha
    Then deployment.Planned succeeds with capability.prefer.degraded planWarning
```

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/epic-proofs/mapping-styles-planner-resolution
```

## Scope

Independent POC promoting resolution fixtures from `control-plane-planner-matching-orchestrator`. Does not implement production `packages/camps` or `packages/yards`; those land in the production slice after S4-02/S4-03.

## Architecture evidence

- `architecture/` — protobuf + CUE + Pact boundary fixtures
- `architecture.md` — parse-don't-validate and event outcomes

## Upstream proofs

| Proof | Role |
| --- | --- |
| `topology-objects-contract` | `bindle` / `camp` / `yard` |
| `camp-mapping-sugar-compiler` | mapping style → Resource Definitions |
| `capability-negotiation-contract` | prefer/require + PlanRejected |
| `provider-options-pattern-contract` | inert `.with(...)` |

## Cascade reconciliation (83d9b5c92)

The `topology-objects-contract` technical proof refresh is absorbed without changing mapping-style resolution evidence.
