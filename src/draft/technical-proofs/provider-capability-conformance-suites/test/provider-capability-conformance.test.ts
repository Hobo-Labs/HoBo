import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createBrokenProvider,
  createFlakyProvider,
  createReferenceLocalProvider,
  hoboVerify,
  listSeedProviderSuites,
  runProviderCapabilitySuites
} from "../src/provider-capability-conformance.js";

test("reference local provider passes local database/objectStore/compute suites", () => {
  const provider = createReferenceLocalProvider();
  const report = runProviderCapabilitySuites(provider, {
    capabilities: ["database", "objectStore", "compute"],
    tags: ["local"]
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.coverage.local.capabilities, ["compute", "database", "objectStore"]);
  assert.equal(report.coverage.local.failed, 0);
  assert.equal(report.coverage.local.passed, report.coverage.local.total);
});

test("broken provider fixtures fail precise destroy and refresh assertions", () => {
  const leaking = createBrokenProvider({ destroyLeaksState: true });
  const leakReport = runProviderCapabilitySuites(leaking, {
    capabilities: ["database"],
    tags: ["local"]
  });

  assert.equal(leakReport.status, "fail");
  assert.equal(leakReport.failures[0].checkId, "database.local.destroy-cleans-state");
  assert.match(leakReport.failures[0].message, /destroy must remove provisioned state/);

  const staleRefresh = createBrokenProvider({ refreshNeverReportsDrift: true });
  const refreshReport = runProviderCapabilitySuites(staleRefresh, {
    capabilities: ["database"],
    tags: ["local"]
  });

  assert.equal(refreshReport.status, "fail");
  assert.equal(refreshReport.failures[0].checkId, "database.local.refresh-reports-drift");
  assert.match(refreshReport.failures[0].message, /must report injected drift/);
});

test("hobo verify reports local plus camp coverage and blocks prod-ready claims without camp checks", () => {
  const provider = createReferenceLocalProvider();
  const report = hoboVerify(provider, {
    capabilities: ["database", "objectStore", "compute"],
    runTags: ["local"],
    claimProdReady: true
  });

  assert.equal(report.status, "fail");
  assert.equal(report.coverage.local.failed, 0);
  assert.equal(report.coverage.camp.status, "unrun");
  assert.match(report.prodReady.message, /camp checks are unrun/);
});

test("prod-ready claims require local coverage even when camp checks pass", () => {
  const provider = createReferenceLocalProvider({ campBehavior: "pass" });
  const report = hoboVerify(provider, {
    capabilities: ["database"],
    runTags: ["camp"],
    claimProdReady: true
  });

  assert.equal(report.status, "fail");
  assert.equal(report.coverage.local.status, "unrun");
  assert.equal(report.coverage.camp.status, "pass");
  assert.match(report.prodReady.message, /local checks are unrun/);
});

test("local-only success does not hide camp-only conformance failures", () => {
  const provider = createReferenceLocalProvider({ campBehavior: "fail" });

  const local = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: ["local"]
  });
  assert.equal(local.status, "pass");

  const camp = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: ["camp"]
  });

  assert.equal(camp.status, "fail");
  assert.equal(camp.failures[0].checkId, "database.camp.real-provider-drift");
  assert.match(camp.failures[0].message, /camp evidence/);
});

test("claimed capabilities without a matching suite fail as a hard coverage gate", () => {
  const provider = createReferenceLocalProvider({
    claimedCapabilities: ["database", "email"]
  });

  const report = hoboVerify(provider, {
    capabilities: provider.manifest.claimedCapabilities,
    runTags: ["local"]
  });

  assert.equal(report.status, "fail");
  assert.equal(report.coverage.missingSuites[0].capability, "email");
  assert.match(report.coverage.missingSuites[0].message, /no provider-capability suite/);
});

test("flaky refresh is rejected instead of certifying an intermittent provider", () => {
  const provider = createFlakyProvider();
  const report = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: ["local"]
  });

  assert.equal(report.status, "fail");
  assert.equal(report.failures[0].checkId, "database.local.refresh-reports-drift");
  assert.match(report.failures[0].message, /deterministic/);
});

test("seed suite catalog covers every HOBO-102 seed port", () => {
  assert.deepEqual(listSeedProviderSuites().map((suite) => suite.capability), [
    "cache",
    "compute",
    "database",
    "dns",
    "objectStore",
    "queue"
  ]);
});

test("every seed port executes local and camp checks under the shared suite contract", () => {
  const seedCapabilities = listSeedProviderSuites().map((suite) => suite.capability);
  const provider = createReferenceLocalProvider({
    claimedCapabilities: seedCapabilities,
    campBehavior: "pass"
  });
  const report = runProviderCapabilitySuites(provider, {
    capabilities: seedCapabilities,
    tags: ["local", "camp"]
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.coverage.local.capabilities, seedCapabilities);
  assert.deepEqual(report.coverage.camp.capabilities, seedCapabilities);
  assert.equal(report.coverage.local.total, 24);
  assert.equal(report.coverage.camp.total, 12);
});
