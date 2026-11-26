import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import * as catalogModule from "../src/catalog.js";
import { CATALOG, catalogFactoryNames, secretRef } from "../src/catalog.js";

const expectedCatalog = Object.freeze([
  { factory: "api", portRef: ["wasi:http", "hobo:http"], verbs: [] },
  { factory: "kv", portRef: ["wasi:keyvalue"], verbs: ["get", "set", "delete"] },
  { factory: "cache", portRef: ["hobo:cache"], verbs: ["get", "set", "delete", "invalidate"] },
  {
    factory: "bucket",
    portRef: ["wasi:blobstore", "hobo:blob-events"],
    verbs: ["read", "write", "delete"]
  },
  { factory: "queue", portRef: ["hobo:queue"], verbs: ["enqueue", "dequeue"] },
  { factory: "topic", portRef: ["wasi:messaging"], verbs: ["publish", "subscribe"] },
  { factory: "secret", portRef: ["wasi:config", "hobo:secrets"], verbs: ["put", "access"] },
  { factory: "data", portRef: ["hobo:data"], verbs: ["read", "write", "query", "admin"] },
  { factory: "schedule", portRef: ["hobo:scheduler"], verbs: [] },
  {
    factory: "websocket",
    portRef: ["wasi:websocket", "hobo:websocket"],
    verbs: ["accept", "connect", "send", "broadcast", "subscribe"]
  },
  { factory: "job", portRef: ["hobo:job"], verbs: ["submit"] },
  { factory: "web", portRef: ["wasi:http"], verbs: [] },
  { factory: "service", portRef: ["wasi:http"], verbs: [] },
  { factory: "flag", portRef: ["hobo:feature-flag"], verbs: ["eval", "change"] },
  { factory: "auth", portRef: ["hobo:auth"], verbs: ["verify", "session"] },
  { factory: "crypto", portRef: ["hobo:crypto"], verbs: ["encrypt", "decrypt", "sign", "verify"] },
  { factory: "notify", portRef: ["hobo:notify"], verbs: ["send"] },
  { factory: "guardrail", portRef: ["hobo:guardrail"], verbs: ["check"] },
  { factory: "ui", portRef: ["hobo:ui-render"], verbs: ["render", "drive"] },
  { factory: "experiment", portRef: ["hobo:experiment"], verbs: ["assign", "expose", "analyze"] }
]);

const expectedFactoryNames = expectedCatalog.map((entry) => entry.factory).sort();

async function readDesignCatalogRows() {
  const designDoc = await readFile(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "docs",
      "design",
      "authoring-resources-wiring.md"
    ),
    "utf8"
  );
  const tableStart = designDoc.indexOf("| Resource |");
  const tableEnd = designDoc.indexOf("**Full Nitric building-block parity", tableStart);
  assert.notEqual(tableStart, -1, "resource catalog table must stay discoverable");
  assert.notEqual(tableEnd, -1, "resource catalog section boundary must stay discoverable");

  return designDoc
    .slice(tableStart, tableEnd)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("| ") && !line.startsWith("|---") && !line.startsWith("| Resource "))
    .map((line) => {
      const [resourceCell, bindlesCell] = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (resourceCell.includes("Search")) {
        return { resource: "search", factory: "data" };
      }

      const factory = bindlesCell.match(/`([a-zA-Z]+)\(name\)/)?.[1];
      assert.ok(factory, `could not parse factory cell: ${bindlesCell}`);
      return { resource: factory, factory };
    });
}

function catalogEntryFor(factory) {
  return CATALOG.find((entry) => entry.factory === factory);
}

test("catalog factories cover each design table row exactly once and exclude search", async () => {
  const designRows = await readDesignCatalogRows();
  assert.ok(
    designRows.some((row) => row.resource === "search" && row.factory === "data"),
    "design table keeps search as explicit non-factory row"
  );

  const designFactories = designRows
    .filter((row) => row.resource !== "search")
    .map((row) => row.factory)
    .sort();
  assert.deepEqual(designFactories, expectedFactoryNames);
  assert.deepEqual(catalogFactoryNames().sort(), expectedFactoryNames);
  assert.equal(new Set(catalogFactoryNames()).size, CATALOG.length);

  for (const factory of expectedFactoryNames) {
    assert.equal(Object.prototype.toString.call(catalogModule[factory]), "[object Function]", `${factory} must be exported`);
  }

  assert.equal("search" in catalogModule, false, "search must not be a catalog factory");
  assert.equal(catalogFactoryNames().includes("search"), false);
});

test("each catalog factory returns the expected typed WIT port handle and verb surface", () => {
  for (const expected of expectedCatalog) {
    const handle = catalogModule[expected.factory](`${expected.factory}-main`);
    assert.equal(handle.kind, expected.factory);
    assert.equal(handle.name, `${expected.factory}-main`);
    assert.deepEqual(handle.portRef, expected.portRef);
    assert.deepEqual(handle.allowVerbs, expected.verbs);
    assert.equal(handle.allowVerbsType, `${expected.factory}.allow`);
    assert.equal(handle.stableId, `${expected.factory}:${expected.factory}-main`);
    assert.deepEqual(handle.identity, {
      kind: expected.factory,
      name: `${expected.factory}-main`,
      stableId: `${expected.factory}:${expected.factory}-main`
    });

    assert.deepEqual(catalogEntryFor(expected.factory), {
      factory: expected.factory,
      portRef: expected.portRef,
      allowVerbs: expected.verbs
    });

    const allowed = handle.allow(...expected.verbs);
    assert.notEqual(allowed, handle);
    assert.deepEqual(allowed.declaredAllow, expected.verbs);

    for (const verb of expected.verbs) {
      assert.equal(Object.prototype.toString.call(handle[verb]), "[object Function]", `${expected.factory}.${verb} must exist`);
      assert.deepEqual(handle[verb]({ example: true }), {
        lowersTo: "hobo:sdk",
        kind: expected.factory,
        name: `${expected.factory}-main`,
        handleStableId: `${expected.factory}:${expected.factory}-main`,
        portRef: expected.portRef,
        verb,
        args: [{ example: true }]
      });
    }
  }
});

test("stable identity is deterministic for later duplicate-name detection", () => {
  const first = catalogModule.bucket("uploads");
  const second = catalogModule.bucket("uploads");
  const different = catalogModule.bucket("logs");

  assert.equal(first.stableId, "bucket:uploads");
  assert.equal(second.stableId, "bucket:uploads");
  assert.equal(different.stableId, "bucket:logs");
  assert.equal(first.stableId, second.stableId);
  assert.notEqual(first.stableId, different.stableId);
});

test("secret catalog resources and secretRef value reads are distinct symbols", () => {
  const managedStore = catalogModule.secret("payment-secrets");
  const valueReference = secretRef("STRIPE_API_KEY");

  assert.equal(managedStore.kind, "secret");
  assert.equal(managedStore.name, "payment-secrets");
  assert.equal(managedStore.stableId, "secret:payment-secrets");
  assert.equal(Object.prototype.toString.call(managedStore.access), "[object Function]");

  assert.equal(valueReference.kind, "secret-ref");
  assert.equal(valueReference.ref, "STRIPE_API_KEY");
  assert.equal(valueReference.catalogFactory, false);
  assert.equal(valueReference.portRef, "wasi:config/hobo:secrets");
  assert.notEqual(valueReference.stableId, managedStore.stableId);
});

test("illegal verbs are blocked by runtime guard and declaration surface", async () => {
  const state = catalogModule.kv("state");

  assert.equal(state.publish, undefined);
  assert.throws(() => state.allow("publish"), /kv does not allow verb "publish"/);
  assert.equal(Object.prototype.toString.call(catalogModule.data("records").query), "[object Function]");

  const declarations = await readFile(
    join(import.meta.dirname, "..", "src", "catalog.d.ts"),
    "utf8"
  );
  const kvInterface = declarations.match(/export interface KvHandle[\s\S]*?\n}/)?.[0];
  assert.ok(kvInterface, "KvHandle declaration must be present");

  assert.match(declarations, /export type KvAllowVerb = "get" \| "set" \| "delete";/);
  assert.match(declarations, /allow\(\.\.\.verbs: readonly Verb\[\]\): this;/);
  assert.match(kvInterface, /get\(/);
  assert.match(kvInterface, /set\(/);
  assert.match(kvInterface, /delete\(/);
  assert.doesNotMatch(kvInterface, /publish\(/);
  assert.doesNotMatch(declarations, /export function search\(/);
});
