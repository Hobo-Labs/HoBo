import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyProviderWithInert,
  composeYard,
  createReferenceShopBindle,
  detectMappingStyle,
  perBindingCamp,
  perTierCamp,
  PLAN_REJECTED_FIXTURE_REASON,
  planCampDeployment,
  referenceAppWithProviderOptions,
  wholeAppCamp
} from "../src/mapping-styles-planner-resolution.js";
import {
  capabilityRequest
} from "../../../technical-proofs/capability-negotiation-contract/src/capability-negotiation.js";
import {
  aws,
  azure,
  database
} from "../../../technical-proofs/provider-options-pattern-contract/src/provider-options-contract.js";

const shop = createReferenceShopBindle();

test("same Bindle resolves to AWS or Azure by mapping edit only", () => {
  const awsCamp = wholeAppCamp(shop, "aws");
  const azureCamp = wholeAppCamp(shop, "azure");

  const awsPlan = planCampDeployment({ campObject: awsCamp });
  const azurePlan = planCampDeployment({ campObject: azureCamp });

  assert.equal(awsPlan.ok, true);
  assert.equal(azurePlan.ok, true);
  assert.equal(awsPlan.providerId, "aws");
  assert.equal(azurePlan.providerId, "azure");
  assert.deepEqual(
    awsPlan.plan.resources.map((resource) => resource.provider),
    ["aws", "aws", "aws"]
  );
  assert.deepEqual(
    azurePlan.plan.resources.map((resource) => resource.provider),
    ["azure", "azure", "azure"]
  );
  assert.equal(awsPlan.event.type, "deployment.Planned");
  assert.equal(azurePlan.event.type, "deployment.Planned");
  assert.equal(shop.name, "shop");
});

test("whole-app mapping style deploys the reference app", () => {
  const campObject = wholeAppCamp(shop, "aws");
  const yardObject = composeYard(campObject);
  const result = planCampDeployment({ campObject });

  assert.equal(detectMappingStyle(campObject), "whole-app");
  assert.equal(yardObject.providerId, "aws");
  assert.equal(result.ok, true);
  assert.equal(result.mappingStyle, "whole-app");
  assert.deepEqual(result.plan.dependencyOrder, ["shop.db", "shop.api", "shop.web"]);
  assert.match(result.plan.rationale.join(" "), /mapping-style:whole-app/);
  assert.match(result.plan.rationale.join(" "), /objective:single-provider/);
});

test("per-tier mapping style deploys the reference app", () => {
  const campObject = perTierCamp(shop, "aws");
  const result = planCampDeployment({ campObject });

  assert.equal(detectMappingStyle(campObject), "per-tier");
  assert.equal(result.ok, true);
  assert.equal(result.mappingStyle, "per-tier");
  assert.equal(result.plan.resources.length, 3);
  assert.match(result.plan.rationale.join(" "), /mapping-style:per-tier/);
});

test("per-binding mapping style deploys the reference app", () => {
  const campObject = perBindingCamp(shop, "azure");
  const result = planCampDeployment({ campObject });

  assert.equal(detectMappingStyle(campObject), "per-binding");
  assert.equal(result.ok, true);
  assert.equal(result.mappingStyle, "per-binding");
  assert.equal(result.providerId, "azure");
  assert.match(result.plan.rationale.join(" "), /mapping-style:per-binding/);
});

test("preferred-but-unoffered capability accepts with planWarning on deployment.Planned", () => {
  const campObject = wholeAppCamp(shop, "azure");
  const result = planCampDeployment({
    campObject,
    portRequestsByResource: {
      "shop.db": [
        capabilityRequest({ port: "database", features: ["managed", "postgres"], strictness: "require" }),
        capabilityRequest({ port: "database", features: ["ha"], strictness: "prefer" })
      ],
      "shop.api": [
        capabilityRequest({ port: "service", features: ["containerService"], strictness: "require" })
      ],
      "shop.web": [
        capabilityRequest({ port: "web", features: ["cdn"], strictness: "require" })
      ]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.event.type, "deployment.Planned");
  assert.ok(
    result.plan.planWarnings.some((warning) => warning.kind === "capability.prefer.degraded"),
    "expected prefer-degraded planWarning when azure lacks database.ha"
  );
  assert.ok(result.plan.planWarnings.some((warning) => warning.feature === "ha"));
});

test("required-but-unoffered capability emits deployment.PlanRejected with fixture reason", () => {
  const campObject = wholeAppCamp(shop, "azure");
  const result = planCampDeployment({
    campObject,
    portRequestsByResource: {
      "shop.db": [
        capabilityRequest({ port: "database", features: ["managed", "ha"], strictness: "require" })
      ],
      "shop.api": [
        capabilityRequest({ port: "service", features: ["containerService"], strictness: "require" })
      ],
      "shop.web": [
        capabilityRequest({ port: "web", features: ["cdn"], strictness: "require" })
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.event.type, "deployment.PlanRejected");
  assert.match(result.reason, /capability\.require\.unsatisfied/);
  assert.match(result.reason, /database\.ha/);
  assert.equal(result.reason, PLAN_REJECTED_FIXTURE_REASON);
});

test(".with(...) options are inert for non-resolved providers", () => {
  const db = database("shop.db", { engine: "postgres" });
  const applied = applyProviderWithInert("aws", db, aws.rds({ multiAz: true }), azure.flexibleServer({ haMode: "zone-redundant" }));

  assert.equal(applied.applied.length, 1);
  assert.equal(applied.inert.length, 1);
  assert.equal(applied.applied[0].provider, "aws");
  assert.equal(applied.inert[0].provider, "azure");
  assert.equal(applied.inert[0].status, "inert");
  assert.deepEqual(applied.resolved, { "aws.rds": { multiAz: true } });
});

test("reference app keeps lock-in markers while applying only resolved provider options", () => {
  const { withResult } = referenceAppWithProviderOptions("azure");

  assert.equal(withResult.applied[0].provider, "azure");
  assert.equal(withResult.inert[0].provider, "aws");
  assert.ok(Object.keys(withResult.manifest.resources["shop.db"].annotations?.with ?? {}).includes("azure.flexibleServer"));
});
