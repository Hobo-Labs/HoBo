# @hobo/identity

Production identity service for HoBo: SPIFFE JWT-SVID issuance from workload
attestation, OIDC discovery/JWKS verification, scope-narrowing rotation, an
append-only credential-audit event stream, and a per-deploy token broker. S2-04
promotes the near-production draft proof
(`src/draft/projects/s3-02-hobo-identity/`) into `packages/identity/`.

## What it does

- `IdentityService` — mints a JWT-SVID for an attested workload
  (`issueSvidFromAttestation`), rotates within the renewal grace window
  (`rotateSvid` / `rotateSvidWithScope`, which rejects scope widening),
  authenticates a token at the gateway (`authenticateAtGateway`), and exposes
  OIDC `discovery()` / `jwks()`. TTL defaults to 900s, renewal grace 300s.
- `TokenBroker` — holds one vaulted root credential and mints per-deploy,
  scope-bound, TTL'd tokens for an SVID, emitting `token.Granted` / `token.Used`
  / `token.Revoked`.
- **Residual secrets backends** ([ADR-0027](../../docs/design/adr/02-identity-security.md#adr-0027) /
  [ADR-0113](../../docs/design/adr/02-identity-security.md#adr-0113)) — secretless-first
  ladder is bound-resource → provider-federation → camp-value → static-escape.
  Built-in residual adapters in `@hobo/identity` (never primary identity):
  - **`createMemorySecretsPort`** — default in-memory residual (local Station / fixtures)
  - `createVaultJwtSecretsPort` — Vault via short-lived SVID JWT (no static Vault token)
  - `createAwsSecretsManagerPort` / `createAzureKeyVaultPort` — brokered live + offline
  - `createCampSecretsPort({ backend: "memory" | "vault-jwt" | "aws-sm" | "azure-kv" })`
  - **`createLocalStationSecretsPort`** — local Station residual; **defaults to memory**
    (`HOBO_LOCAL_SECRETS_BACKEND=memory|vault-jwt`). Wasm guests never see material.
  - `asHoboSecretsStore` — WIT-shaped residual view over any port
  - **Optional OpenBao:** install **`@hobo/adapter-openbao`** (not a default dependency)
    for residual OpenBao JWT + KV v2. Not included in default installs.
  - **Optional Infisical:** **`@hobo/adapter-infisical`** implements the
    `infisical` port kind (workload OIDC sign-in, no secret zero); the hosted CI
    relay's config service (ADR-0179). Not a default dependency.
- Every identity and token event carries the never-compact
  `CREDENTIAL_AUDIT_RETENTION` descriptor.
- **Continuous Identity Migration Plane** ([ADR-0132](../../docs/design/adr/02-identity-security.md#adr-0132))
  — dual-path PrincipalRef continuity when adapters, residency, spectrum, or
  Yard placement change. **Nothing is required in the Bindle** for continuous
  migration: Matching + policy activate dual mode; progressive ramp uses
  existing Harness cohort flags; dual fixtures extend [ADR-0070](../../docs/design/adr/02-identity-security.md#adr-0070)
  for offline `hobo dev` / tests. Observe with `hobo identity status` /
  `hobo identity inspect <id>` and `hobo doctor`. Composed into **HoBo Trails**
  ([ADR-0134](../../docs/design/adr/02-identity-security.md#adr-0134),
  `@hobo/trails`) as the platform recipe `identity.continuous` — pure identity
  continuous cases still require **zero Trail authoring**.
- **The Harness** ([ADR-0083](../../docs/design/adr/02-identity-security.md#adr-0083) /
  [ADR-0044](../../docs/design/adr/02-identity-security.md#adr-0044)) — progressive
  delivery as a native plane: single `FeatureFlagStore` (shared with identity
  migration cohorts — **no parallel store**), OpenFeature-only app API
  (`HoboOpenFeatureProvider` / `HoboFeatureClient`), OpenDelivery staged
  rollouts + auto-rollback obligations, OpenExperiment assignment/exposure,
  policy-gated mutations, and contract-asserted local fixtures. Bindle IfC:
  `features()` / `declareExperiment()` / `rollout()` from `@hobo/bindles`.
  CLI: `hobo feature list|eval|set|kill|canary|experiment`.

## The Harness (feature flags · progressive delivery · experiments)

```ts
import {
  FeatureFlagStore,
  createLocalFeatureClient,
  createHarness,
  createContractAssertedHarnessFixtures,
  enrichEvaluationContext,
  gateFlagMutation,
} from "@hobo/identity";
import { features, rollout, declareExperiment } from "@hobo/bindles";

// Bindle IfC (schema is truth; runtime values live in the store)
const appFeatures = features({
  "new-checkout-flow": {
    state: "ENABLED",
    percentage: 10,
    variants: { control: false, treatment: true },
    defaultVariant: "control",
  },
});

// Sole public evaluation API shape (OpenFeature)
const store = new FeatureFlagStore();
const client = createLocalFeatureClient(store, { userId: "user:alice", tenant: "acme" });
const on = client.getBooleanValue("new-checkout-flow", false);

// Progressive composition: flag ramp → gateway weight → auto-rollback
const harness = createHarness({ store });
const run = harness.startProgressive({
  rollout: {
    name: "checkout-canary",
    flag: "new-checkout-flow",
    stages: [{ percent: 5 }, { percent: 25 }, { percent: 100 }],
    traffic: "gateway-weighted",
    autoRollback: true,
  },
  experiment: {
    name: "checkout-exp",
    flag: "new-checkout-flow",
    variants: ["control", "treatment"],
  },
});
// Offline local path
const fx = createContractAssertedHarnessFixtures();
fx.client.getBooleanDetails("example-feature", false);
```

Application code **never** imports flagd, Unleash, GrowthBook, LaunchDarkly, or
Argo. External backends rank behind `hobo:feature-flag` / `hobo:delivery` /
`hobo:experiment` ports (local-builtin → camp-managed → ofrep-internal → external).
Gateway-weighted rollouts emit `domain.RoutingChanged` via
`applyRolloutToGatewayRouting`. Experiment `analyzeExperiment` /
`concludeExperiment` use the built-in baseline analysis/export (commercial
engines plug in as residual adapters).

## Continuous identity migration (hands-off)

```ts
import {
  decideIdentityMigration,
  defaultContinuousMappingSpec,
  createContractAssertedDualFixtures,
  IdentityMigrationService,
  evaluateCanMigrate,
} from "@hobo/identity";

// Matching decides — no Bindle dual-adapter block required.
const decision = decideIdentityMigration({
  tenant: "acme",
  sourceAdapter: "oidc-legacy",
  targetAdapter: "oidc-modern",
});

const dual = createContractAssertedDualFixtures({ tenant: "acme" });
const can = evaluateCanMigrate({
  sourceAdapter: dual.sourceAdapter,
  targetAdapter: dual.targetAdapter,
  mapping: dual.mapping,
  dualOracleReady: true,
});

const svc = new IdentityMigrationService({ tenant: "acme" });
svc.start({
  tenant: "acme",
  sourceAdapter: decision.sourceAdapter,
  targetAdapter: decision.targetAdapter,
  mapping: decision.mapping,
  reason: decision.reason,
  mode: decision.mode,
  matchDecisionId: decision.decisionId,
});
// JIT link keeps both adapters valid until cutover (ADR-0100 grace patterns).
```

## Deferred: keyless provider-STS exchange (S3-03)

The broker returns a deterministic fixture-scoped token derived inside the
vault. The real keyless OIDC-federation / provider-STS token exchange is a later
item (S3-03); see the `ponytail:` note in `src/token-broker.ts`.

## Exports

- `IdentityService`, `createFixtureHostAttestor`, `verifyWorkloadAttestation`,
  `JwtSvidIssuer`, `createInMemoryKms`, `verifyJwtWithJwks`.
- `TokenBroker`, `createInMemoryVault`, `TokenScope`, `ScopedTokenGrant`.
- Event factories/validators and `CREDENTIAL_AUDIT_RETENTION`.
- `IDENTITY_PORT` — the `IdentityProvider` port descriptor built through
  `@hobo/core`.
- Migration plane: `IdentityMigrationControlPlane` (Matching → auto-start →
  OpenFeature ramp → cutover), `IdentityMigrationService`,
  `decideIdentityMigration`, `evaluateCanMigrate`,
  `createContractAssertedDualFixtures` / `createDualAdapterPair`,
  `FeatureFlagStore`, `runSpectrumIdentityCutover` (Plan 50 composition),
  `dualVerifyClaims`, `mintDualAudienceGrant`, `advanceMigrationRamp`,
  `agentActionsForMigrationEvents`, `identity.Migration*` events.
- Harness: `HoboOpenFeatureProvider`, `HoboFeatureClient`, `createHarness`,
  `OpenDeliveryEngine`, `OpenExperimentEngine`, `gateFlagMutation`,
  `createContractAssertedHarnessFixtures`, `enrichEvaluationContext`,
  `selectFeatureFlagBackend`, `flag.*` / `rollout.*` / `experiment.*` events.

## Verification

```sh
pnpm --filter @hobo/identity build
pnpm --filter @hobo/identity test
pnpm --filter @hobo/identity test:contract:consumer
```
