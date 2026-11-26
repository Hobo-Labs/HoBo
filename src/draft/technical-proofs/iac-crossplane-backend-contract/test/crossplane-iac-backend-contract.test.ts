import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createCrossplaneIacAdapter,
  createFixtureIacProgram,
  createInMemoryCrossplaneCluster,
  runIacBackendConformanceSuite,
} from "../src/crossplane-iac-backend-contract.js";

describe("@hobo/iac-crossplane backend contract", () => {
  it("previews, applies, refreshes, and destroys a fixture IacProgram through Crossplane claims", async () => {
    const cluster = createInMemoryCrossplaneCluster();
    const iac = createCrossplaneIacAdapter({ cluster });
    const program = createFixtureIacProgram();

    assert.deepEqual(await iac.preview(program), {
      kind: "diff",
      provider: "crossplane",
      dirty: true,
      changes: [
        { op: "create", resource: "database", reason: "claim-missing" },
        { op: "create", resource: "cache", reason: "claim-missing" },
      ],
    });

    const outputs = await iac.apply(program);

    assert.deepEqual(outputs, {
      kind: "outputs",
      provider: "crossplane",
      resources: {
        database: {
          id: "crossplane:claim:database",
          status: "ready",
          outputs: {
            endpoint: "postgres.database.svc.cluster.local",
            resourceId: "managed/database",
          },
        },
        cache: {
          id: "crossplane:claim:cache",
          status: "ready",
          outputs: {
            endpoint: "redis.cache.svc.cluster.local",
            resourceId: "managed/cache",
          },
        },
      },
      stackOutputs: {
        cacheEndpoint: "redis.cache.svc.cluster.local",
        databaseEndpoint: "postgres.database.svc.cluster.local",
      },
    });

    assert.deepEqual(await iac.preview(program), {
      kind: "diff",
      provider: "crossplane",
      dirty: false,
      changes: [],
    });
    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "crossplane",
      drifted: false,
      resources: [],
    });

    assert.deepEqual(await iac.destroy(program), {
      kind: "outputs",
      provider: "crossplane",
      resources: {
        database: { id: "crossplane:claim:database", status: "destroyed", outputs: {} },
        cache: { id: "crossplane:claim:cache", status: "destroyed", outputs: {} },
      },
      stackOutputs: {},
    });
  });

  it("reports out-of-band controller drift from the observed claim status and spec", async () => {
    const cluster = createInMemoryCrossplaneCluster();
    const iac = createCrossplaneIacAdapter({ cluster });
    const program = createFixtureIacProgram();
    await iac.apply(program);

    cluster.mutateClaim("database", {
      specPatch: { parameters: { storageGiB: 99 } },
      statusPatch: { endpoint: "postgres-drifted.database.svc.cluster.local" },
    });

    assert.deepEqual(await iac.refresh(program), {
      kind: "drift-report",
      provider: "crossplane",
      drifted: true,
      resources: [
        { name: "database", reason: "spec-drift" },
        { name: "database", reason: "status-output-drift", output: "endpoint" },
      ],
    });
  });

  it("turns a stuck non-Ready managed resource into a bounded apply timeout", async () => {
    const cluster = createInMemoryCrossplaneCluster({ stuckClaims: ["database"] });
    const iac = createCrossplaneIacAdapter({ cluster, readyPollLimit: 2 });

    await assert.rejects(() => iac.apply(createFixtureIacProgram()), {
      name: "CrossplaneApplyError",
      code: "ready-timeout",
      message: /database did not reach Ready after 2 polls/,
    });
  });

  it("fails closed when a composition selector matches zero or multiple compositions", async () => {
    const missing = createCrossplaneIacAdapter({
      cluster: createInMemoryCrossplaneCluster({ compositions: [] }),
    });
    await assert.rejects(() => missing.preview(createFixtureIacProgram()), {
      name: "CrossplaneProgramError",
      code: "composition-not-found",
      message: /database selector matched no Crossplane Composition/,
    });
    await assert.rejects(() => missing.apply(createFixtureIacProgram()), {
      name: "CrossplaneProgramError",
      code: "composition-not-found",
      message: /database selector matched no Crossplane Composition/,
    });

    const ambiguous = createCrossplaneIacAdapter({
      cluster: createInMemoryCrossplaneCluster({
        compositions: [
          { name: "postgres-a", labels: { port: "database", class: "postgres" } },
          { name: "postgres-b", labels: { port: "database", class: "postgres" } },
          { name: "redis", labels: { port: "cache", class: "redis" } },
        ],
      }),
    });
    await assert.rejects(() => ambiguous.preview(createFixtureIacProgram()), {
      name: "CrossplaneProgramError",
      code: "composition-ambiguous",
      message: /database selector matched multiple Crossplane Compositions: postgres-a, postgres-b/,
    });
    await assert.rejects(() => ambiguous.apply(createFixtureIacProgram()), {
      name: "CrossplaneProgramError",
      code: "composition-ambiguous",
      message: /database selector matched multiple Crossplane Compositions: postgres-a, postgres-b/,
    });
  });

  it("rejects apply when required Crossplane CRDs are not installed", async () => {
    const iac = createCrossplaneIacAdapter({
      cluster: createInMemoryCrossplaneCluster({ installedCrds: ["Composition"] }),
    });

    await assert.rejects(() => iac.apply(createFixtureIacProgram()), {
      name: "CrossplaneProgramError",
      code: "crd-missing",
      message: /missing required Crossplane CRD CompositeResourceClaim/,
    });
  });

  it("passes the shared IaC-backend conformance smoke suite", async () => {
    const result = await runIacBackendConformanceSuite({
      adapter: createCrossplaneIacAdapter({ cluster: createInMemoryCrossplaneCluster() }),
      program: createFixtureIacProgram(),
    });

    assert.deepEqual(result, {
      provider: "crossplane",
      previewDirtyBeforeApply: true,
      applyReady: true,
      refreshCleanAfterApply: true,
      destroyRemovedClaims: true,
    });
  });
});
