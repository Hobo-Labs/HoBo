# @hobo/trails

**HoBo Trails** — versioned, app-owned, composable continuous migration
runbooks/recipes. Platform continuous identity duals remain hands-off (zero
Bindle config); app-authored Trails cover schema/data transforms and cross-cloud
moves over junctions.

## Quick start

```ts
import {
  createContractAssertedTrailFixtures,
  defineTrail,
  TrailRunner,
  evaluateCanTrail,
  runTrailGoldenSuite,
  PLATFORM_RECIPES,
  activateIdentityContinuousFromMatching,
  createHandsOffIdentityTrail,
} from "@hobo/trails";

// Hands-off continuous identity (Matching-driven; zero authoring)
// Public surface is Trails-owned DTOs only — no @hobo/identity types leak.
const id = createHandsOffIdentityTrail({ tenant: "acme" });
activateIdentityContinuousFromMatching({ handle: id });

// App-authored data Trail composed with platform recipes
const trail = defineTrail({
  id: "app.checkout.migrate",
  version: "2026.07.27.1",
  recipeList: [PLATFORM_RECIPES.IdentityContinuous, PLATFORM_RECIPES.ValidationOracle],
  steps: [
    {
      id: "schema-v1",
      kind: "schema",
      schema: { mode: "expand-contract", version: "1" },
      progressive: true,
    },
    {
      id: "data-dual",
      kind: "continuous-dual-data",
      dependsOn: ["schema-v1"],
      data: {
        mode: "cdc-dual",
        transformId: "checkout.backfill",
        checksum: "sha256:" + "a".repeat(64),
      },
    },
  ],
});

const runner = new TrailRunner({ tenant: "acme", target: "staging" });
const plan = runner.plan(trail);
const result = runner.run(trail);
const golden = runTrailGoldenSuite(result, {
  bindleConfigRequired: false,
  continuousDefault: true,
});
```

## Local fixtures

```ts
const fx = createContractAssertedTrailFixtures({ tenant: "local" });
// fx.fidelity === "simulated"
fx.runner.run(fx.appTrail);
fx.identity; // hands-off continuous identity handle
```

## CLI

```
hobo trails status
hobo trails plan
hobo trails inspect <id>
```

## Principles

1. Continuous identity = platform recipe, Matching/policy, dual fixtures — **no Trail authoring required**.
2. App Trails = versioned schema/data/junction steps composed with platform recipes.
3. Progressive ramp via existing Harness `FeatureFlagStore`.
4. Fail-closed dual oracles + compensation; history is durable and idempotent.

## Data migrations (ADR-0177)

Trails composes data migrations; it does not implement a storage engine.

- **No engine is imported.** The schema-apply and dual-run ports are declared
  here as shapes. `@hobo/data-sqlite` satisfies them today; any other
  `@hobo/data-<engine>` package can. The package-boundary gate
  (`pnpm run lint:boundaries`) refuses, anywhere under `src/`, an import of an
  engine package, of a database driver (`node:sqlite`, `pg`, `mongodb`, …), or
  of `@hobo/storage-sqlite` — static, dynamic `import()`, or `require()`, and
  whether or not the package is listed only under `devDependencies`. Tests may
  import any of them.
- **One executor.** `executeDataMigration` is `@hobo/data-core`'s
  `in-place-evolve` pattern behind Trails' own types. It accepts a `policy`
  callback — recomputed before every phase, a negative verdict holds the
  migration at its last safe state — and a `replayErasures` callback, called
  after every restore so a rollback cannot resurrect an erased subject.
- **Evidence, not rows.** A dual-run port that offers `evidence()` is judged on
  counts and digests; no row leaves the store. `snapshot()` remains for the
  simulated-fixture oracle.
- **A computed gate.** `evaluateCanTrail` accepts a `policyVerdict` computed by
  `@hobo/data-core` over the migration's custody path. A dump file, a relaying
  runner, or a rollback snapshot in the wrong place blocks the trail and is
  named in the reason. The gate is a conjunction and fails closed: the trail is
  denied when `policyAllows` is `false`, or `residencyConflict` is `true`, or
  the verdict is negative or carries a finding. A passing verdict does not lift
  a denial stated beside it, and the booleans alone still work when no verdict
  is supplied. A verdict that is not the record
  `data-models/migration.cue` pins (`ok`, a `findings` list, a `sha256:`
  `custodyDigest`) blocks the trail with a `policy-denied` reason; it neither
  throws nor passes. Each reason code appears once, with every cause in its
  message.
- **Patterns.** A data step may name the migration pattern it realizes
  (`data.pattern`), from the closed catalog in `@hobo/data-core`.

```ts
import { evaluateCustodyPath, parseCustodyPath } from "@hobo/data-core";
import { createSqliteDataDualPort } from "@hobo/data-sqlite";
import { evaluateCanTrail, TrailRunner } from "@hobo/trails";

const verdict = evaluateCustodyPath({ path: parseCustodyPath(custody), policy, now });
const gate = evaluateCanTrail({ trail, policyVerdict: verdict });

const dual = createSqliteDataDualPort({ sourcePath, targetPath, tenant: "acme" });
const result = new TrailRunner({ tenant: "acme", target: "silo-a", dataDual: dual }).run(trail);
```
