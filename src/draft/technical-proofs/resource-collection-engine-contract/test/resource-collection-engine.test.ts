import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { evaluateCollectionCoverage } from "../../collection-coverage-gate-contract/src/collection-coverage-gate.js";
import {
  CollectionEngineError,
  collectBindleResources,
  parseCollectionInput,
} from "../src/index.js";

const todosSource = `
  import { api, kv } from "@hobo/bindles";

  export default function define(includeCache = false) {
    const todos = kv("todos");
    todos.get("todo-1");
    todos.set("todo-1", { title: "ship" });

    const http = api("api", { bind: { todos } });
    http.route("GET", "/todos", () => todos.get("todo-1"));

    if (includeCache) {
      kv("cache");
    }
  }
`;

const coverageGateEvaluator = (context) =>
  evaluateCollectionCoverage({
    sourceText: context.sourceText,
    observedResourceIds: [...context.observedResourceIds],
    observedBindKeys: [...context.observedBindKeys],
    fileName: context.fileName,
  });

function defineTodos(collect) {
  const todos = collect.kv("todos");
  todos.get("todo-1");
  todos.set("todo-1", { title: "ship" });

  const api = collect.api("api", { bind: { todos } });
  api.route("GET", "/todos", () => todos.get("todo-1"));
}

function collectTodos(overrides = {}) {
  return collectBindleResources({
    bindleId: "todos",
    fileName: "todos.ts",
    sourceText: todosSource,
    define: defineTodos,
    coverageEvaluator: coverageGateEvaluator,
    ...overrides,
  });
}

describe("resource-collection engine contract", () => {
  it("parseCollectionInput is the single parse boundary for raw input", () => {
    const parsed = parseCollectionInput({
      define(collect) {
        collect.kv("todos");
      },
    });
    assert.equal(parsed.bindleId, "bindle");
    assert.equal(parsed.fileName, "bindle.ts");
    assert.deepEqual(parsed.componentHost, {
      kind: "wasmtime",
      version: "46.0.1",
    });
  });

  it("collects an IfC Bindle into hobo.manifest/v1 resources, links, and inferred used verbs", () => {
    const result = collectTodos();

    assert.equal(result.manifest.schema, "hobo.manifest/v1");
    assert.deepEqual(result.manifest.componentHost, {
      kind: "wasmtime",
      version: "46.0.1",
    });
    assert.deepEqual(result.manifest.resources.todos, {
      type: "data.v1",
      port: "wasi:keyvalue",
      kind: "kv",
      allow: ["get", "set"],
      usage: {
        inferred: ["get", "set"],
        source: "run-to-collect",
      },
      collection: {
        stableId: "kv:todos",
      },
    });
    assert.deepEqual(result.manifest.resources.api, {
      type: "component.v1",
      kind: "api",
      runtime: "wasm",
      exports: ["wasi:http/incoming-handler"],
      links: [{ import: "wasi:keyvalue", to: "todos" }],
      routes: [{ method: "GET", path: "/todos" }],
      bindings: {
        todos: {
          port: "wasi:keyvalue",
          resource: "todos",
          clientType: "KvClient",
        },
      },
      collection: {
        stableId: "api:api",
      },
    });
    assert.deepEqual(result.coverage.observedResourceIds, ["todos", "api"]);
    assert.deepEqual(result.coverage.observedBindKeys, ["api->todos"]);
  });

  it("emits bindle.ResourcesCollected and bindle.ManifestProduced facts with the manifest payload", () => {
    const result = collectTodos();

    assert.deepEqual(
      result.events.map((event) => event.type),
      ["bindle.ResourcesCollected", "bindle.ManifestProduced"],
    );
    assert.equal(result.events[0].source, "hobo.collector");
    assert.equal(result.events[0].seq, 1);
    assert.equal(result.events[1].seq, 2);
    assert.deepEqual(result.events[0].data.resources, ["todos", "api"]);
    assert.deepEqual(result.events[0].data.binds, ["api->todos"]);
    assert.equal(result.events[1].data.manifestHash, result.manifestHash);
    assert.deepEqual(result.events[1].data.manifest, result.manifest);
    assert.match(String(result.manifestHash), /^sha256:[0-9a-f]{64}$/);
  });

  it("content-addresses the manifest deterministically across equivalent collection runs", () => {
    const first = collectTodos();
    const second = collectTodos();

    assert.equal(first.manifestHash, second.manifestHash);
    assert.deepEqual(first.events, second.events);
  });

  it("surfaces statically declared but unobserved resources through the injected CoverageEvaluator seam", () => {
    const result = collectTodos();

    assert.equal(result.coverage.ok, false);
    assert.equal(result.coverage.status, "fail");
    assert.deepEqual(
      result.coverage.unobservedDeclarations.map((declaration) => declaration.resourceId),
      ["cache"],
    );
    assert.match(
      result.coverage.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
      /cache/,
    );
  });

  it("ignores collection-time network and clock side effects so manifest hashing stays stable", () => {
    function defineWithSideEffects(collect) {
      collect.effects.clock.now();
      collect.effects.network.fetch("https://example.invalid/metadata");
      const todos = collect.kv("todos");
      todos.get("todo-1");
      const api = collect.api("api", { bind: { todos } });
      api.route("GET", "/todos", () => todos.get("todo-1"));
    }

    function defineWithoutSideEffects(collect) {
      const todos = collect.kv("todos");
      todos.get("todo-1");
      const api = collect.api("api", { bind: { todos } });
      api.route("GET", "/todos", () => todos.get("todo-1"));
    }

    const sourceText = `
      import { api, kv } from "@hobo/bindles";
      const todos = kv("todos");
      todos.get("todo-1");
      api("api", { bind: { todos } });
    `;
    const withEffects = collectBindleResources({
      bindleId: "todos",
      fileName: "todos.ts",
      sourceText,
      define: defineWithSideEffects,
    });
    const withoutEffects = collectBindleResources({
      bindleId: "todos",
      fileName: "todos.ts",
      sourceText,
      define: defineWithoutSideEffects,
    });

    assert.equal(withEffects.manifestHash, withoutEffects.manifestHash);
    assert.deepEqual(withEffects.sideEffects, [
      {
        kind: "clock.now",
        disposition: "ignored",
      },
      {
        kind: "network.fetch",
        target: "https://example.invalid/metadata",
        disposition: "ignored",
      },
    ]);
  });

  it("fails duplicate resource declarations instead of silently merging them", () => {
    assert.throws(
      () =>
        collectBindleResources({
          bindleId: "dupe",
          define(collect) {
            collect.kv("todos");
            collect.kv("todos");
          },
        }),
      (error) => {
        assert.ok(error instanceof CollectionEngineError);
        assert.equal(error.path, "resources.todos");
        assert.match(error.message, /duplicate resource id/);
        return true;
      },
    );
  });

  it("rejects routes on non-component resources", () => {
    assert.throws(
      () =>
        collectBindleResources({
          bindleId: "bad-route",
          define(collect) {
            collect.kv("todos").route("GET", "/nope");
          },
        }),
      (error) => {
        assert.ok(error instanceof CollectionEngineError);
        assert.equal(error.path, "resources.todos.route");
        return true;
      },
    );
  });

  it("rejects bogus allow verbs", () => {
    assert.throws(
      () =>
        collectBindleResources({
          bindleId: "bad-allow",
          define(collect) {
            collect.kv("todos").allow("bogus");
          },
        }),
      (error) => {
        assert.ok(error instanceof CollectionEngineError);
        assert.equal(error.path, "resources.todos.allow");
        return true;
      },
    );
  });
});
