# Deployment Strategy Saga Orchestrator (HOBO-658)

Epic-scoped draft POC for S6-03: per-service deployment strategy sagas
(recreate, blue-green, canary, progressive) with health-gated promotion and
S6-01 auto-rollback decision wiring.

Production target: `packages/cloud/src/orchestrator/` (S6-01 acceptance record merged).
This package promotes harness fixtures from
`src/draft/epic-proofs/progressive-delivery-harness/` and composes the existing
`deployment-strategy-saga-templates-contract` + `slo-gated-rollback-analysis-contract`
proofs without live providers.

## Vertical slice

```gherkin
Feature: Per-service deployment strategy sagas

  Persona: Platform operator

  Scenario: deploy multi-cloud-shop with mixed strategies
    Given each service declares recreate, blue-green, canary, or progressive
    When the orchestrator runs health-gated promotion with data-plane + provider signals
    Then every strategy promotes the reference app to green or auto-rolls back event-sourced
```

## Acceptance mapping

| Acceptance | Executable proof |
|---|---|
| Strategy templates selectable per service | `selects recreate, blue-green, canary, and progressive templates per service` |
| Each strategy deploys reference app green in CI | `deploys multi-cloud-shop reference app green for every strategy in CI` |
| Seeded canary regression auto-rolls back event-sourced | `auto-rolls back seeded canary regression on multi-cloud-shop with event-sourced decision` |
| Health-gated promotion from data-plane + provider signals | `health-gates promotion from data-plane and provider health signals` |
| Golden-suite failure adversarial guard | `rolls back on golden-suite failure adversarial case` |

## Verify

```bash
pnpm --prefix src/draft/epic-proofs/deployment-strategy-saga-orchestrator test
pnpm --prefix src/draft/epic-proofs/deployment-strategy-saga-orchestrator run simulate
```

## Architecture evidence

- `architecture/deployment_strategy_saga_orchestrator.proto` — protobuf shapes
- `architecture/deployment_strategy_saga_orchestrator.cue` — CUE constraints
- `architecture/pacts/deployment_strategy_saga_orchestrator.pact.json` — boundary PACT

## Cascade reconciliation (83d9b5c92)

The `slo-gated-rollback-analysis-contract` technical proof refresh is absorbed without changing strategy selection or rollback evidence.
