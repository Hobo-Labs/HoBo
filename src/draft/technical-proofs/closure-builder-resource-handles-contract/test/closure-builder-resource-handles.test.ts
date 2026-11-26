import assert from "node:assert/strict";
import { test } from "vitest";

import {
  bindle,
  ClosureBuilderResourceError,
  createResourceIdentityLedger,
  resourceIdentityDiagnostics,
  type ResourceHandle,
} from "../src/closure-builder-resource-handles.ts";


test("closure-builder authoring creates anonymous handles and dependsOn relationships without starting workloads", () => {
  let started = false;
  const myApi = {
    run() {
      started = true;
      return "server";
    },
  };

  const shop = bindle("shop", (b) => {
    const cache = b.cache();
    const api = b.api(() => myApi.run()).dependsOn(cache);

    return { cache, api };
  });

  assert.equal(started, false);
  assert.equal(shop.name, "shop");
  assert.deepEqual(shop.resources.map((resource) => resource.kind), ["cache", "api"]);
  assert.deepEqual(shop.relationships, [
    {
      from: "res_api_0001",
      to: "res_cache_0001",
      verb: "dependsOn",
    },
  ]);
});

test("invalid dependencies fail clearly", () => {
  const catalog = bindle("catalog", (b) => ({ queue: b.queue() }));

  assert.throws(
    () =>
      bindle("shop", (b) => {
        const api = b.api(() => undefined);
        api.dependsOn(catalog.resources[0]);
        return { api };
      }),
    (error) =>
      error instanceof ClosureBuilderResourceError &&
      error.code === "CLOSURE_BUILDER_CROSS_BINDLE_DEPENDENCY",
  );

  assert.throws(
    () =>
      bindle("shop", (b) => {
        const api = b.api(() => undefined);
        api.dependsOn({ kind: "cache" });
        return { api };
      }),
    (error) =>
      error instanceof ClosureBuilderResourceError &&
      error.code === "CLOSURE_BUILDER_INVALID_DEPENDENCY",
  );
});

test("builder resource factories reject explicit names at runtime", () => {
  assert.throws(
    () =>
      bindle("shop", (b) => {
        // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
        const named: (name: string) => ResourceHandle<"cache"> = b.cache as never;
        const cache = named("cache");
        // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
        return { cache: cache as never };
      }),
    (error) =>
      error instanceof ClosureBuilderResourceError &&
      error.code === "CLOSURE_BUILDER_NAMED_RESOURCE_ARG",
  );
});

test("provider with annotations stay inert resource annotations, not relationship verbs", () => {
  const providerAnnotation = { provider: "aws", resource: "fargate" };

  const shop = bindle("shop", (b) => {
    const cache = b.cache();
    const api = b.api(() => undefined).with(providerAnnotation).dependsOn(cache);
    return { cache, api };
  });

  assert.deepEqual(shop.resources[1].annotations, [providerAnnotation]);
  assert.deepEqual(shop.relationships.map((relationship) => relationship.verb), ["dependsOn"]);
});

test("generated resource IDs survive alias rename, returned-key reorder, and inserted resources", () => {
  const original = bindle("shop", (b) => {
    const cache = b.cache();
    const api = b.api(() => undefined).dependsOn(cache);
    return { cache, api };
  });

  const renamedAndReordered = bindle("shop", (b) => {
    const cache = b.cache();
    const api = b.api(() => undefined).dependsOn(cache);
    return { service: api, data: cache };
  });

  const insertedResource = bindle("shop", (b) => {
    const cache = b.cache();
    const queue = b.queue();
    const api = b.api(() => undefined).dependsOn(cache, queue);
    return { cache, queue, api };
  });

  const originalIds = resourceIdentityDiagnostics(original);
  const renamedIds = resourceIdentityDiagnostics(renamedAndReordered);
  const insertedIds = resourceIdentityDiagnostics(insertedResource);

  assert.equal(renamedIds.find((entry) => entry.alias === "data")?.generatedId, originalIds[0].generatedId);
  assert.equal(renamedIds.find((entry) => entry.alias === "service")?.generatedId, originalIds[1].generatedId);
  assert.equal(insertedIds.find((entry) => entry.alias === "cache")?.generatedId, originalIds[0].generatedId);
  assert.equal(insertedIds.find((entry) => entry.alias === "api")?.generatedId, originalIds[1].generatedId);
});

test("identity diagnostics keep aliases separate from generated IDs and physical naming seeds", () => {
  const shop = bindle("shop", (b) => {
    const cache = b.cache();
    const api = b.api(() => undefined).dependsOn(cache);
    return { renamedCache: cache, renamedApi: api };
  });

  assert.deepEqual(resourceIdentityDiagnostics(shop), [
    {
      alias: "renamedCache",
      generatedId: "res_cache_0001",
      kind: "cache",
      ownerBindleId: "shop",
      physicalNameSeed: "shop:res_cache_0001",
    },
    {
      alias: "renamedApi",
      generatedId: "res_api_0001",
      kind: "api",
      ownerBindleId: "shop",
      physicalNameSeed: "shop:res_api_0001",
    },
  ]);
});

test("collector-owned identity ledger preserves existing generated IDs across same-kind insertion", () => {
  const ledger = createResourceIdentityLedger({
    bindleName: "shop",
    artifactOwner: "hobo-collector",
    updateFlow: "collector-proposes-review-accepts",
    reviewBoundary: "code-review",
    entries: [
      {
        kind: "cache",
        occurrence: 1,
        generatedId: "res_cache_0002",
        identitySource: "hobo-generated",
        reviewState: "pending-new",
      },
      {
        kind: "cache",
        occurrence: 2,
        generatedId: "res_cache_0001",
        identitySource: "hobo-generated",
        reviewState: "accepted",
      },
      {
        kind: "api",
        occurrence: 1,
        generatedId: "res_api_0001",
        identitySource: "hobo-generated",
        reviewState: "accepted",
      },
    ],
  });

  const shop = bindle(
    "shop",
    (b) => {
      const insertedCache = b.cache();
      const existingCache = b.cache();
      const api = b.api(() => undefined).dependsOn(existingCache);

      return { insertedCache, renamedExistingCache: existingCache, api };
    },
    { identityLedger: ledger },
  );

  assert.deepEqual(resourceIdentityDiagnostics(shop), [
    {
      alias: "insertedCache",
      generatedId: "res_cache_0002",
      kind: "cache",
      ownerBindleId: "shop",
      physicalNameSeed: "shop:res_cache_0002",
    },
    {
      alias: "renamedExistingCache",
      generatedId: "res_cache_0001",
      kind: "cache",
      ownerBindleId: "shop",
      physicalNameSeed: "shop:res_cache_0001",
    },
    {
      alias: "api",
      generatedId: "res_api_0001",
      kind: "api",
      ownerBindleId: "shop",
      physicalNameSeed: "shop:res_api_0001",
    },
  ]);
  assert.deepEqual(shop.relationships, [
    {
      from: "res_api_0001",
      to: "res_cache_0001",
      verb: "dependsOn",
    },
  ]);
});

test("identity ledger rejects alias-derived identity and does not re-enable named resource factories", () => {
  assert.throws(
    () =>
      createResourceIdentityLedger({
        bindleName: "shop",
        artifactOwner: "hobo-collector",
        updateFlow: "collector-proposes-review-accepts",
        reviewBoundary: "code-review",
        entries: [
          {
            kind: "cache",
            occurrence: 1,
            generatedId: "res_cache_0001",
            identitySource: "local-alias",
            reviewState: "accepted",
            alias: "cache",
          },
        ],
      }),
    (error) =>
      error instanceof ClosureBuilderResourceError &&
      error.code === "CLOSURE_BUILDER_LEDGER_ALIAS_IDENTITY",
  );

  assert.throws(
    () =>
      createResourceIdentityLedger({
        bindleName: "shop",
        artifactOwner: "hobo-collector",
        updateFlow: "collector-proposes-review-accepts",
        reviewBoundary: "code-review",
        entries: [
          {
            kind: "cache",
            occurrence: 1,
            generatedId: "res_cache_0001",
            identitySource: "hobo-generated",
            reviewState: "accepted",
            returnedKey: "cache",
          },
        ],
      }),
    (error) =>
      error instanceof ClosureBuilderResourceError &&
      error.code === "CLOSURE_BUILDER_LEDGER_ALIAS_IDENTITY",
  );

  const ledger = createResourceIdentityLedger({
    bindleName: "shop",
    artifactOwner: "hobo-collector",
    updateFlow: "collector-proposes-review-accepts",
    reviewBoundary: "code-review",
    entries: [
      {
        kind: "cache",
        occurrence: 1,
        generatedId: "res_cache_0001",
        identitySource: "hobo-generated",
        reviewState: "accepted",
      },
    ],
  });

  assert.throws(
    () =>
      bindle(
        "shop",
        (b) => {
          // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
          const named: (name: string) => ResourceHandle<"cache"> = b.cache as never;
        const cache = named("cache");
          // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
          return { cache: cache as never };
        },
        { identityLedger: ledger },
      ),
    (error) =>
      error instanceof ClosureBuilderResourceError &&
      error.code === "CLOSURE_BUILDER_NAMED_RESOURCE_ARG",
  );
});
