# Pact inventory — S5 Stage Gate Forge Extensibility

| Pact file | Provider boundary | Consumer |
|---|---|---|
| `forge-registry-certification.pact.json` | ForgeRegistryCertification | S5StageGateForgeDrill |
| `bindle-deploy-journey.pact.json` | BindleDeployOrchestrator | S5StageGateForgeDrill |
| `stub-impl-eval-promotion.pact.json` | StubImplEvalPromotionGate | S5StageGateForgeDrill |
| `live-fix-auto-rollback.pact.json` | LiveFixAutoRollbackGate | S5StageGateForgeDrill |

Consumer verification: `contracts/consumer/stage-gate-boundaries.test.ts`
