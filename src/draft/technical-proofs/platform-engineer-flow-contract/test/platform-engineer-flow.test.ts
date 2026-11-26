import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixturePlatform,
  createSnapshopManifest,
  explainResolution,
  hoboPlanPlatform,
  hoboUpPlatform,
  manifestDigest
} from "../src/platform-engineer-flow.js";

test("platform engineer flow registers a provider, maps a Camp, plans, and realizes topology", async () => {
  const platform = createFixturePlatform();
  const manifest = createSnapshopManifest();

  const plan = hoboPlanPlatform({ platform, manifest, campId: "prod" });

  assert.equal(plan.ok, true, plan.errors.join("\n"));
  assert.deepEqual(
    plan.decisions.map((decision) => [decision.context.resourceId, decision.winner.id]),
    [
      ["catalog", "azure.default.kv"],
      ["images", "azure.default.bucket"],
      ["main", "azure.default.api"]
    ]
  );
  assert.deepEqual(
    plan.matchEvents.map((event) => [event.type, event.data.resourceId, event.data.winner]),
    [
      ["match.Decided", "catalog", "azure.default.kv"],
      ["match.Decided", "images", "azure.default.bucket"],
      ["match.Decided", "main", "azure.default.api"]
    ]
  );

  const up = await hoboUpPlatform({ platform, manifest, campId: "prod" });

  assert.equal(up.status, "realized");
  assert.deepEqual(
    up.realizedResources.map((resource) => [resource.id, resource.providerId, resource.definitionId]),
    [
      ["catalog", "azure", "azure.default.kv"],
      ["images", "azure", "azure.default.bucket"],
      ["main", "azure", "azure.default.api"]
    ]
  );
  assert.deepEqual(
    up.events.map((event) => event.type),
    [
      "provider.Registered",
      "camp.Mapped",
      "match.Decided",
      "match.Decided",
      "match.Decided",
      "deployment.Planned",
      "yard.Realized",
      "camp.Realized"
    ]
  );
});

test("a per-resource override changes one resolution and leaves the rest inferred", () => {
  const manifest = createSnapshopManifest();
  const platform = createFixturePlatform({
    overrides: [
      {
        id: "platform.catalog.cosmos",
        type: "kv",
        provider: "azure",
        driver: "terraform",
        match: { resourceId: "catalog" },
        priority: 0,
        with: { service: "azure:cosmos", consistency: "session" }
      }
    ]
  });

  const plan = hoboPlanPlatform({ platform, manifest, campId: "prod" });

  assert.equal(plan.ok, true, plan.errors.join("\n"));
  assert.deepEqual(
    plan.decisions.map((decision) => [decision.context.resourceId, decision.winner.id]),
    [
      ["catalog", "platform.catalog.cosmos"],
      ["images", "azure.default.bucket"],
      ["main", "azure.default.api"]
    ]
  );
  assert.deepEqual(
    plan.decisions.find((decision) => decision.context.resourceId === "catalog").rejectedCandidates,
    []
  );
  assert.deepEqual(plan.manifestDigest, manifestDigest(manifest));
});

test("resolutions are queryable without changing the app manifest", () => {
  const manifest = createSnapshopManifest();
  const platform = createFixturePlatform();
  const originalManifest = structuredClone(manifest);
  const before = manifestDigest(manifest);

  const plan = hoboPlanPlatform({ platform, manifest, campId: "prod" });
  const explanations = ["catalog", "images", "main"].map((resourceId) =>
    explainResolution(plan, resourceId)
  );

  assert.equal(manifestDigest(manifest), before);
  assert.deepEqual(
    explanations.map((explanation) => ({
      resourceId: explanation.resourceId,
      winner: explanation.winner,
      providerId: explanation.providerId,
      ranking: explanation.ranking,
      rejectedCandidates: explanation.rejectedCandidates,
      catalogContentHash: explanation.catalogContentHash
    })),
    [
      {
        resourceId: "catalog",
        winner: "azure.default.kv",
        providerId: "azure",
        ranking: ["azure.default.kv"],
        rejectedCandidates: [],
        catalogContentHash: plan.decisions[0].catalogContentHash
      },
      {
        resourceId: "images",
        winner: "azure.default.bucket",
        providerId: "azure",
        ranking: ["azure.default.bucket"],
        rejectedCandidates: [],
        catalogContentHash: plan.decisions[1].catalogContentHash
      },
      {
        resourceId: "main",
        winner: "azure.default.api",
        providerId: "azure",
        ranking: ["azure.default.api"],
        rejectedCandidates: [],
        catalogContentHash: plan.decisions[2].catalogContentHash
      }
    ]
  );
  assert.deepEqual(manifest, originalManifest);
});

test("unsupported capabilities fail planning with the port named and do not realize", async () => {
  const platform = createFixturePlatform();
  const manifest = createSnapshopManifest({
    resources: [
      { id: "catalog", type: "kv" },
      { id: "jobs", type: "queue" }
    ]
  });

  const plan = hoboPlanPlatform({ platform, manifest, campId: "prod" });
  const up = await hoboUpPlatform({ platform, manifest, campId: "prod" });

  assert.equal(plan.ok, false);
  assert.match(plan.errors.join("\n"), /no ResourceDefinition candidates for queue/);
  assert.equal(up.status, "blocked");
  assert.equal(up.realizedResources.length, 0);
  assert.match(up.reason, /queue/);
});

test("colliding overrides resolve deterministically and surface a tie warning", () => {
  const platform = createFixturePlatform({
    overrides: [
      {
        id: "platform.catalog.beta",
        type: "kv",
        provider: "azure",
        driver: "terraform",
        match: { resourceId: "catalog" },
        with: { service: "azure:beta" }
      },
      {
        id: "platform.catalog.alpha",
        type: "kv",
        provider: "azure",
        driver: "terraform",
        match: { resourceId: "catalog" },
        with: { service: "azure:alpha" }
      }
    ]
  });

  const plan = hoboPlanPlatform({ platform, manifest: createSnapshopManifest(), campId: "prod" });
  const catalog = plan.decisions.find((decision) => decision.context.resourceId === "catalog");

  assert.equal(catalog.winner.id, "platform.catalog.alpha");
  assert.equal(catalog.tie, true);
  assert.deepEqual(catalog.tiedDefinitionIds, ["platform.catalog.alpha", "platform.catalog.beta"]);
  assert.match(catalog.planWarnings[0], /true tie/);
});

test("unapproved inferred Camps and unknown Camp or provider names fail clearly", () => {
  const platform = createFixturePlatform({ approvedDefaultProviders: [] });
  const inferredCamp = {
    id: "inferred-preview",
    provider: "azure",
    iac: "pulumi",
    envType: "ephemeral",
    inferred: true
  };

  const denied = hoboPlanPlatform({
    platform,
    manifest: createSnapshopManifest(),
    campId: "inferred-preview",
    inferredCamp
  });
  const unknownCamp = hoboPlanPlatform({ platform, manifest: createSnapshopManifest(), campId: "missing" });
  const unknownProvider = hoboPlanPlatform({
    platform: createFixturePlatform({
      camps: [{ id: "prod", provider: "missing-cloud", iac: "pulumi", envType: "production" }]
    }),
    manifest: createSnapshopManifest(),
    campId: "prod"
  });

  assert.equal(denied.ok, false);
  assert.match(denied.errors.join("\n"), /provider azure is not approved as a default for inferred Camp inferred-preview/);
  assert.equal(unknownCamp.ok, false);
  assert.match(unknownCamp.errors.join("\n"), /unknown Camp missing/);
  assert.equal(unknownProvider.ok, false);
  assert.match(unknownProvider.errors.join("\n"), /unknown provider missing-cloud for Camp prod/);
});
