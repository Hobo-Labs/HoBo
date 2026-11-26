import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  CATALOG,
  catalogFactoryNames,
  kv,
} from "../../hobo-bindles-resource-catalog/src/catalog.js";
import { createCollectionContext } from "../src/collection-context.js";

const here = dirname(fileURLToPath(import.meta.url));
const pactPath = join(
  here,
  "../architecture/pacts/hobo-collector-hobo-bindles.pact.json",
);

describe("collector ↔ bindles SDK pact", () => {
  it("pins the catalog surface the collector consumes", () => {
    const state = {
      resources: new Map(),
      bindEdges: [],
      sideEffects: [],
    };
    const collect = createCollectionContext(state);
    const handle = collect.kv("todos");
    handle.get("todo-1");
    handle.allow("get");

    const pact = {
      consumer: { name: "@hobo/collector" },
      provider: { name: "@hobo/bindles" },
      interactions: [
        {
          description: "collector reads catalog factory metadata",
          request: { method: "GET", path: "/bindles/catalog" },
          response: {
            status: 200,
            body: {
              factoryNames: catalogFactoryNames(),
              catalog: CATALOG.map((entry) => ({
                factory: entry.factory,
                portRef: [...entry.portRef],
                allowVerbs: [...entry.allowVerbs],
              })),
            },
          },
        },
        {
          description: "collector exercises kv handle shape and verb narrowing",
          request: { method: "POST", path: "/bindles/handle/kv" },
          response: {
            status: 200,
            body: {
              kind: handle.kind,
              name: handle.name,
              stableId: handle.stableId,
              declaredAllow: ["get"],
              lowering: handle.get("todo-1"),
            },
          },
        },
      ],
      metadata: {
        pactSpecification: { version: "3.0.0" },
      },
    };

    writeFileSync(pactPath, `${JSON.stringify(pact, null, 2)}\n`, "utf8");

    const catalogHandle = kv("sessions");
    assert.equal(catalogHandle.kind, "kv");
    assert.equal(catalogHandle.stableId, "kv:sessions");
    assert.throws(() => catalogHandle.allow("bogus"));
    assert.equal(pact.consumer.name, "@hobo/collector");
    assert.equal(pact.provider.name, "@hobo/bindles");
    assert.ok(pact.interactions.length >= 2);
  });
});
