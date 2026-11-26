import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createPortableMultiCloudShopRun,
  runMultiCloudShopE2eFixture,
  verifyMultiCloudShopGate,
} from "../src/multi-cloud-shop-gate.js";

test("multi-cloud-shop deploys the same Bindle to AWS and Azure with identical topology and bindings", () => {
  const evidence = createPortableMultiCloudShopRun();
  const report = verifyMultiCloudShopGate(evidence);

  assert.equal(report.ok, true);
  assert.deepEqual(report.targetProviders, ["aws", "azure"]);
  assert.equal(new Set(evidence.targets.map((target) => target.bindleDigest)).size, 1);
  assert.deepEqual(
    evidence.targets.map((target) => target.mappingDigest),
    ["sha256:camp-aws-mapping", "sha256:camp-azure-mapping"],
  );
  assert.equal(report.events[0].type, "multiCloudShop.GatePassed");
});

test("AWS-only .with options apply only to AWS and leave Azure unaffected", () => {
  const evidence = createPortableMultiCloudShopRun();
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
  assert.equal(verifyMultiCloudShopGate(evidence).ok, true);
});

test("unsatisfied require rejects with precise deployment.PlanRejected evidence", () => {
  const evidence = createPortableMultiCloudShopRun();
  const scenario = evidence.negativeScenarios.find((item) => item.kind === "unsatisfied-require");

  assert.deepEqual(scenario.result.event, {
    type: "deployment.PlanRejected",
    reason: "require.unsatisfied",
    missingCapability: "vector-index",
    checkedProviders: ["aws", "azure"],
    detail: "catalog-search requires vector-index; checked aws, azure; no provider satisfies it",
  });
  assert.equal(verifyMultiCloudShopGate(evidence).ok, true);
});

test("single-provider features are refused on providers that cannot satisfy them", () => {
  const evidence = createPortableMultiCloudShopRun();
  const scenario = evidence.negativeScenarios.find((item) => item.kind === "unsupported-single-provider-feature");

  assert.equal(scenario.result.ok, false);
  assert.equal(scenario.result.event.type, "deployment.PlanRejected");
  assert.deepEqual(scenario.result.event.unsupportedProviders, ["azure"]);
  assert.equal(verifyMultiCloudShopGate(evidence).ok, true);
});

test("byte-identical Bindle carrying a .with leak to cloud N is refused", () => {
  const evidence = createPortableMultiCloudShopRun({
    targets: [
      createPortableMultiCloudShopRun().targets[0],
      {
        ...createPortableMultiCloudShopRun().targets[1],
        resolvedProviderOptions: [
          {
            resourceId: "orders",
            provider: "aws",
            name: "aws.rds.multiAz",
            value: true,
          },
        ],
      },
    ],
  });
  const report = verifyMultiCloudShopGate(evidence);

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "provider-option.leaked");
  assert.match(report.failures[0].message, /reached azure/);
});

test("raw driver leaks that are not satisfied by every target are refused", () => {
  const evidence = createPortableMultiCloudShopRun({
    portabilityReport: {
      nonPortableSurface: [
        {
          id: "assets.raw.aws.s3.accelerate",
          category: "raw-dialect-leak",
          resourceId: "assets",
          driver: "aws",
          satisfiedBy: ["aws"],
        },
      ],
    },
  });
  const report = verifyMultiCloudShopGate(evidence);

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    code: "portability.unsatisfied-surface",
    message: "assets.raw.aws.s3.accelerate is not satisfied by azure",
    entryId: "assets.raw.aws.s3.accelerate",
    unsatisfiedTargets: ["azure"],
  });
});

test("binding divergence across providers fails the equivalence assertion", () => {
  const base = createPortableMultiCloudShopRun();
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
  const report = verifyMultiCloudShopGate(createPortableMultiCloudShopRun({ targets: [base.targets[0], azure] }));

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "topology.binding-mismatch");
  assert.match(report.failures[0].message, /azure bindings differ from aws/);
});

test("provider with unrun camp checks cannot make a prod-ready claim", () => {
  const base = createPortableMultiCloudShopRun();
  const azure = {
    ...base.targets[1],
    campChecks: [{ name: "azure.provider-conformance", status: "not-run" }],
  };
  const report = verifyMultiCloudShopGate(createPortableMultiCloudShopRun({ targets: [base.targets[0], azure] }));

  assert.equal(report.ok, false);
  assert.deepEqual(report.failures[0], {
    code: "camp-checks.unrun",
    message: "azure cannot make a prod-ready claim without passed camp checks",
    provider: "azure",
    checks: ["azure.provider-conformance"],
  });
});

test("gated camp-tagged E2E lane emits a green fixture report", () => {
  const run = runMultiCloudShopE2eFixture({
    phase: "deploy-and-assert",
    runId: "run-231",
  });

  assert.equal(run.ok, true);
  assert.equal(run.fixture, "examples/multi-cloud-shop");
  assert.deepEqual(run.providers, ["aws", "azure"]);
  assert.equal(run.report.ciLane, "multi-cloud-shop-e2e");
});
