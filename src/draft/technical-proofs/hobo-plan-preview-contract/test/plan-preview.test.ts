import assert from "node:assert/strict";
import { test } from "vitest";

import { validateDeploymentPlan } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import {
  createSamplePlanFixture,
  renderHumanPlan,
  renderJsonPlan,
  runHoboPlan
} from "../src/plan-preview.js";

test("human plan renders each sample resource with provider reason and estimated cost", () => {
  const fixture = createSamplePlanFixture();
  const result = runHoboPlan(["--camp", "prod"], fixture);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.preview.sideEffectEvents, []);
  assert.equal(validateDeploymentPlan(result.preview.deploymentPlan).ok, true);

  assert.match(result.stdout, /catalog\s+kv\s+-> azure\.tableStorage\s+\[provider default for prod kv; est \$12\.40\/mo\]/);
  assert.match(result.stdout, /images\s+bucket\s+-> aws\.s3\s+\[provider default for prod bucket; est \$9\.10\/mo\]/);
  assert.match(result.stdout, /api\s+http\s+-> azure\.containerApp\s+\[component host for prod api; est \$42\.00\/mo\]/);
  assert.match(result.stdout, /Warnings/);
  assert.match(result.stdout, /non-portable raw\(\) escape on catalog/);
  assert.match(result.stdout, /cross-cloud edge api -> images uses public-mtls/);
});

test("--json emits a stable CI envelope without human output", () => {
  const fixture = createSamplePlanFixture();
  const first = runHoboPlan(["--camp", "prod", "--json"], fixture);
  const second = runHoboPlan(["--json", "--camp", "prod"], fixture);

  assert.equal(first.exitCode, 1);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.doesNotMatch(first.stdout, /^Resource\s+Port\s+Provider/m);

  const envelope = JSON.parse(first.stdout);
  assert.equal(envelope.schema, "hobo.plan-preview/v1");
  assert.equal(envelope.command, "hobo plan");
  assert.equal(envelope.camp, "prod");
  assert.equal(envelope.status, "would-change");
  assert.equal(envelope.exitCode, 1);
  assert.equal(envelope.sideEffectEvents.length, 0);
  assert.equal(envelope.cost.estimated, true);
  assert.deepEqual(envelope.cost.assumptions, [
    "30 day month",
    "provider catalog prices are list estimates",
    "egress rounded to the declared connectivity tier"
  ]);
  assert.equal(renderJsonPlan(envelope), first.stdout);
});

test("no-op re-plan after up shows zero changes", () => {
  const fixture = createSamplePlanFixture();
  const first = runHoboPlan(["--camp", "prod", "--json"], fixture);
  const planned = JSON.parse(first.stdout);

  const afterUp = runHoboPlan(["--camp", "prod", "--json"], {
    ...fixture,
    currentDeploymentSet: {
      camp: "prod",
      planHash: planned.planHash
    }
  });
  const envelope = JSON.parse(afterUp.stdout);

  assert.equal(afterUp.exitCode, 0);
  assert.equal(envelope.status, "no-op");
  assert.deepEqual(envelope.changes, []);
  assert.equal(envelope.summary, "0 changes");
});

test("unresolved required capability fails with the offending port named", () => {
  const fixture = createSamplePlanFixture({
    resources: [
      {
        id: "ordersWarehouse",
        port: "analytics",
        className: "warehouse",
        requiredCapability: "columnar-analytics",
        outputs: ["dsn"]
      }
    ]
  });

  const result = runHoboPlan(["--camp", "prod"], fixture);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot resolve required capability columnar-analytics/);
  assert.match(result.stderr, /offending port ordersWarehouse \(analytics\)/);
  assert.equal(result.preview.status, "would-fail-planning");
});

test("adversarial cases are surfaced as warnings and clear CLI errors", () => {
  const fixture = createSamplePlanFixture({
    providerDefinitions: [
      {
        id: "aws.s3-fast",
        port: "bucket",
        provider: "aws.s3.fast",
        cloud: "aws",
        driver: "terraform",
        costMonthlyUsd: 9.1,
        reason: "same specificity bucket candidate",
        supportedCapabilities: ["object-storage"],
        match: { camp: "prod" },
        priority: 20
      }
    ]
  });
  const result = runHoboPlan(["--camp", "prod", "--json"], fixture);
  const envelope = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(
    envelope.warnings.find((warning) => warning.code === "ambiguous-provider-resolution"),
    {
      code: "ambiguous-provider-resolution",
      resourceId: "images",
      message: "ambiguous provider resolution for images; stable winner aws.s3 with candidates aws.s3, aws.s3.fast",
      candidates: ["aws.s3", "aws.s3.fast"]
    }
  );
  assert.deepEqual(envelope.crossCloudEdges, [
    {
      from: "api",
      to: "images",
      fromProvider: "azure.containerApp",
      toProvider: "aws.s3",
      connectivityTier: "public-mtls"
    }
  ]);

  const unknownCamp = runHoboPlan(["--camp", "moon"], createSamplePlanFixture());
  assert.equal(unknownCamp.exitCode, 2);
  assert.equal(unknownCamp.stdout, "");
  assert.match(unknownCamp.stderr, /unknown camp "moon"; known camps: prod, staging/);
});

test("renderers accept a completed preview directly", () => {
  const result = runHoboPlan(["--camp", "prod"], createSamplePlanFixture());

  assert.equal(renderHumanPlan(result.preview), result.stdout);
  assert.equal(renderJsonPlan(result.preview).endsWith("\n"), true);
});
