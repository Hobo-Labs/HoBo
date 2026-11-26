import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertNfr001PortabilityLane,
  createPortableConformanceEvidence,
  runNfr001PortabilityLane,
  seedEditedBindleMutation,
  seedProviderLeakMutation,
} from "../src/nfr-001-portability-lane.js";
import {
  createMultiCloudShopFixtureRecord,
  digestPortableSources,
  loadMultiCloudShopSources,
  MULTI_CLOUD_SHOP_FIXTURE,
} from "../src/multi-cloud-shop-fixture.js";
import {
  canonicalAgnosticEdges,
  parseWorkspaceEdge,
  seededProviderLeakEdge,
  validateNfr020BoundaryImports,
} from "../src/nfr-020-boundary-lint.js";

test("multi-cloud-shop fixture exposes bindle.ts and src/ as the portable surface", () => {
  const sources = loadMultiCloudShopSources();
  const fixture = createMultiCloudShopFixtureRecord();

  assert.ok(sources["bindle.ts"].includes("bindle(\"multi-cloud-shop\""));
  assert.equal(sources["src/api.ts"].trim(), 'export const serviceName = "multi-cloud-shop-api";');
  assert.equal(fixture.fixture, MULTI_CLOUD_SHOP_FIXTURE);
  assert.equal(fixture.bindleDigest, digestPortableSources(sources));
});

test("NFR-001 lane passes when the same unedited Bindle deploys to AWS and Azure with identical topology", () => {
  const evidence = createPortableConformanceEvidence();
  const report = assertNfr001PortabilityLane(evidence);

  assert.equal(report.ok, true);
  assert.deepEqual(report.targetProviders, ["aws", "azure"]);
  assert.equal(new Set(evidence.targets.map((target) => target.bindleDigest)).size, 1);
  assert.deepEqual(
    evidence.targets.map((target) => target.mappingDigest),
    ["sha256:camp-aws-mapping", "sha256:camp-azure-mapping"],
  );
  assert.equal(report.events[0].type, "conformance.Nfr001PortabilityLanePassed");
});

test("only camp()/yard() mapping varies across cloud targets", () => {
  const evidence = createPortableConformanceEvidence();
  const aws = evidence.targets.find((target) => target.provider === "aws");
  const azure = evidence.targets.find((target) => target.provider === "azure");

  assert.notEqual(aws.mappingDigest, azure.mappingDigest);
  assert.equal(aws.bindleDigest, azure.bindleDigest);
  assert.notEqual(aws.camp, azure.camp);
  assert.notEqual(aws.yard, azure.yard);
});

test("AWS-only .with options apply only to AWS and leave Azure unaffected", () => {
  const evidence = createPortableConformanceEvidence();
  const aws = evidence.targets.find((target) => target.provider === "aws");
  const azure = evidence.targets.find((target) => target.provider === "azure");

  assert.deepEqual(aws.resolvedProviderOptions, [
    {
      resourceId: "orders",
      provider: "aws",
      name: "aws.rds.multiAz",
      value: true,
    },
  ]);
  assert.deepEqual(azure.resolvedProviderOptions, []);
  assert.equal(runNfr001PortabilityLane(evidence).ok, true);
});

test("adversarial: seeded provider-leak mutation fails the NFR-001 lane", () => {
  const evidence = seedProviderLeakMutation(createPortableConformanceEvidence());
  const report = runNfr001PortabilityLane(evidence);

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "provider-option.leaked");
  assert.match(report.failures[0].message, /reached azure/);
});

test("adversarial: edited-Bindle mutation fails the unedited byte-identical assertion", () => {
  const evidence = seedEditedBindleMutation(createPortableConformanceEvidence());
  const report = runNfr001PortabilityLane(evidence);

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "bindle.not-byte-identical");
  assert.match(report.failures[0].message, /azure did not deploy the exact same bindle/);
});

test("binding divergence across providers fails topology equivalence", () => {
  const base = createPortableConformanceEvidence();
  const azure = {
    ...base.targets[1],
    deployment: {
      ...base.targets[1].deployment,
      bindings: [
        { from: "frontend", to: "api", contract: "https" },
        { from: "api", to: "orders", contract: "sqlserver" },
        { from: "api", to: "assets", contract: "object-store" },
      ],
    },
  };
  const report = runNfr001PortabilityLane({
    ...base,
    targets: [base.targets[0], azure],
  });

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "topology.binding-mismatch");
});

test("NFR-020 boundary lint accepts canonical agnostic workspace edges", () => {
  const edges = canonicalAgnosticEdges.map((edge) => parseWorkspaceEdge(edge));
  const report = validateNfr020BoundaryImports(edges);

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
});

test("NFR-020 boundary lint fails seeded core/sdk to provider import", () => {
  const edges = canonicalAgnosticEdges.map((edge) => parseWorkspaceEdge(edge));
  const report = validateNfr020BoundaryImports(edges, [
    parseWorkspaceEdge(seededProviderLeakEdge),
  ]);

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /NFR-020: agnostic sdk package must not import provider\/adapter/);
});

test("NFR-020 boundary lint fails core importing any HoBo package", () => {
  const report = validateNfr020BoundaryImports([], [
    parseWorkspaceEdge({ from: "packages/core", to: "packages/bindles" }),
  ]);

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /core must not import HoBo packages/);
});
