import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildCoverageReport,
  createSuiteRegistry,
  evaluatePublishGate,
  loadWitCapabilityCatalog,
  recertifyProvider,
  runS4ProviderRecertificationMatrix,
  S4_PROVIDER_CLAIMS,
} from "../src/wit-interface-conformance-coverage.js";

test("coverage report shows 100% suite-backed when every catalog interface has a suite", async () => {
  const catalog = await loadWitCapabilityCatalog();
  const registry = createSuiteRegistry(catalog);
  const report = buildCoverageReport(catalog, registry, {
    generatedAt: "2026-07-02T00:00:00.000Z",
  });

  assert.equal(report.schema, "hobo.conformance.wit-coverage-report/v1");
  assert.equal(report.totalInterfaces, catalog.interfaces.length);
  assert.equal(report.suiteBackedCount, catalog.interfaces.length);
  assert.equal(report.coveragePercent, 100);
  assert.equal(report.complete, true);
  assert.deepEqual(report.gaps, []);
});

test("coverage report fails closed when a catalog interface lacks a suite", async () => {
  const catalog = await loadWitCapabilityCatalog();
  const missing = catalog.interfaces[0].wit;
  const registry = createSuiteRegistry(catalog, { omitWits: [missing] });
  const report = buildCoverageReport(catalog, registry);

  assert.equal(report.complete, false);
  assert.ok(report.coveragePercent < 100);
  assert.deepEqual(report.gaps, [{ wit: missing, reason: "missing-suite" }]);
});

test("publish gate blocks registry listing when a claimed interface fails conformance", async () => {
  const catalog = await loadWitCapabilityCatalog();
  const registry = createSuiteRegistry(catalog);
  const coverageReport = buildCoverageReport(catalog, registry);

  const recertification = await recertifyProvider({
    providerId: "@hobo/provider-aws",
    claimedPorts: S4_PROVIDER_CLAIMS.aws,
    registry,
    failingPorts: ["database"],
    seed: "hobo-s5-02-adversarial-seed",
  });

  assert.equal(recertification.allPassed, false);
  assert.ok(recertification.failedInterfaces.includes("hobo:capability/database@0.1.0"));

  const decision = evaluatePublishGate({
    providerId: "@hobo/provider-aws",
    coverageReport,
    recertification,
  });

  assert.equal(decision.status, "blocked");
  assert.ok(decision.blockingReasons.includes("provider.interface-failed"));
  assert.ok(
    decision.blockingReasons.some((reason) =>
      reason.startsWith("provider.failed-interface:hobo:capability/database@0.1.0"),
    ),
  );
});

test("publish gate rejects forged conformance reports", async () => {
  const catalog = await loadWitCapabilityCatalog();
  const registry = createSuiteRegistry(catalog);
  const coverageReport = buildCoverageReport(catalog, registry);
  const recertification = await recertifyProvider({
    providerId: "@hobo/provider-aws",
    claimedPorts: S4_PROVIDER_CLAIMS.aws,
    registry,
    seed: "hobo-s5-02-forged-seed",
  });

  const decision = evaluatePublishGate({
    providerId: "@hobo/provider-aws",
    coverageReport,
    recertification,
    forgedReport: true,
  });

  assert.equal(decision.status, "blocked");
  assert.ok(decision.blockingReasons.includes("conformance.forged-report"));
});

test("S4 AWS, Azure, and Cloudflare providers re-certify under the per-interface gate", async () => {
  const catalog = await loadWitCapabilityCatalog();
  const registry = createSuiteRegistry(catalog);
  const matrix = await runS4ProviderRecertificationMatrix(catalog, registry, {
    seed: "hobo-s5-02-s4-matrix-seed",
  });

  assert.equal(matrix.coverageReport.complete, true);
  assert.equal(matrix.recertifications.length, 3);
  assert.equal(matrix.publishDecisions.length, 3);
  assert.equal(matrix.allListed, true);

  for (const recertification of matrix.recertifications) {
    assert.equal(recertification.allPassed, true);
    assert.equal(
      recertification.interfaceResults.length,
      recertification.claimedPorts.length,
    );

    for (const result of recertification.interfaceResults) {
      assert.equal(result.report.ok, true);
      assert.equal(result.report.claim.status, "listed");
    }
  }

  for (const decision of matrix.publishDecisions) {
    assert.equal(decision.status, "listed");
    assert.deepEqual(decision.blockingReasons, []);
  }
});

test("publish gate blocks when provider claims an interface the catalog does not suite-back", async () => {
  const catalog = await loadWitCapabilityCatalog();
  const registry = createSuiteRegistry(catalog, {
    omitWits: ["hobo:capability/dns@0.1.0"],
  });
  const coverageReport = buildCoverageReport(catalog, registry);

  const recertification = await recertifyProvider({
    providerId: "@hobo/provider-cloudflare",
    claimedPorts: S4_PROVIDER_CLAIMS.cloudflare,
    registry,
    seed: "hobo-s5-02-uncovered-claim-seed",
  });

  const decision = evaluatePublishGate({
    providerId: "@hobo/provider-cloudflare",
    coverageReport,
    recertification,
  });

  assert.equal(decision.status, "blocked");
  assert.ok(decision.blockingReasons.includes("coverage.incomplete"));
  assert.ok(decision.blockingReasons.includes("provider.claimed-uncovered-interface"));
});
