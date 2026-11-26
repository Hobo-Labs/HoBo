import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CapabilityDeniedError,
  createCapabilityRuntime,
  evaluateCapabilityGrants,
  inferCapabilityUsage,
} from "../src/capability-enforcement.js";

const sourceText = `
  import { api, kv } from "@hobo/bindles";

  const todos = kv("todos").allow("get");
  todos.get("todo-1");

  const http = api("api", { bind: { todos } });
  http.route("GET", "/todos", () => todos.get("todo-1"));
`;

test("infers the used-set and records it as manifest grants", () => {
  const result = evaluateCapabilityGrants({
    sourceText,
    manifest: {
      schema: "hobo.manifest/v1",
      resources: {
        todos: {
          type: "data.v1",
          port: "wasi:keyvalue",
          allow: ["get"],
        },
        api: {
          type: "component.v1",
          links: [{ import: "wasi:keyvalue", to: "todos" }],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.resources.todos.usage, {
    inferred: ["get"],
    source: "static-analysis",
  });
  assert.deepEqual(result.grants, [
    {
      componentId: "api",
      importInterface: "wasi:keyvalue",
      resource: "todos",
      operations: ["get"],
    },
  ]);
});

test("requires both a link and an inferred grant before routing a capability call", async () => {
  const evaluation = evaluateCapabilityGrants({
    sourceText,
    manifest: {
      schema: "hobo.manifest/v1",
      resources: {
        todos: {
          type: "data.v1",
          port: "wasi:keyvalue",
          allow: ["get"],
        },
        api: {
          type: "component.v1",
          links: [{ import: "wasi:keyvalue", to: "todos" }],
        },
      },
    },
  });
  const runtime = createCapabilityRuntime({ grants: evaluation.grants });
  runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
  runtime.registerProvider({
    id: "local-kv",
    exports: {
      "wasi:keyvalue": {
        get: ({ key }) => ({ value: `stored:${key}` }),
        set: () => ({ ok: true }),
      },
    },
  });
  runtime.link({
    componentId: "api",
    importInterface: "wasi:keyvalue",
    providerId: "local-kv",
    exportInterface: "wasi:keyvalue",
  });

  const handle = runtime.issueHandle({
    componentId: "api",
    importInterface: "wasi:keyvalue",
  });

  assert.deepEqual(await runtime.callWithHandle(handle, "get", { key: "todo-1" }), {
    value: "stored:todo-1",
  });
  await assert.rejects(
    () => runtime.callWithHandle(handle, "set", { key: "todo-1", value: "mutate" }),
    (error) =>
      error instanceof CapabilityDeniedError &&
      error.code === "capability.operation-not-granted" &&
      error.operation === "set",
  );
});

test("refuses to issue a handle for a linked import without an inferred grant", () => {
  const runtime = createCapabilityRuntime();
  runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
  runtime.registerProvider({
    id: "local-kv",
    exports: {
      "wasi:keyvalue": {
        get: () => ({ value: "should-not-route" }),
      },
    },
  });
  runtime.link({
    componentId: "api",
    importInterface: "wasi:keyvalue",
    providerId: "local-kv",
    exportInterface: "wasi:keyvalue",
  });

  assert.throws(
    () => runtime.issueHandle({ componentId: "api", importInterface: "wasi:keyvalue" }),
    (error) =>
      error instanceof CapabilityDeniedError &&
      error.code === "capability.no-inferred-grant",
  );
});

test("fails can-deploy when .allow narrows below observed usage", () => {
  const result = evaluateCapabilityGrants({
    sourceText: `
      import { kv } from "@hobo/bindles";
      const todos = kv("todos").allow("get");
      todos.set("todo-1", { title: "ship" });
    `,
    manifest: {
      schema: "hobo.manifest/v1",
      resources: {
        todos: {
          type: "data.v1",
          port: "wasi:keyvalue",
          allow: ["get"],
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [
    {
      code: "capability.allow.narrow-below-usage",
      severity: "error",
      resource: "todos",
      allowedOperations: ["get"],
      observedOperations: ["set"],
      message: "Resource todos observes capability operations outside declared .allow().",
    },
  ]);
});

test("fails closed when static analysis cannot prove a dynamic capability call", () => {
  const usage = inferCapabilityUsage({
    sourceText: `
      import { kv } from "@hobo/bindles";
      const todos = kv("todos").allow("get");
      todos[method]("todo-1");
    `,
    fileName: "dynamic.ts",
  });

  assert.equal(usage.ok, false);
  assert.deepEqual(usage.diagnostics, [
    {
      code: "capability.usage.cannot-prove-operation",
      severity: "error",
      resource: "todos",
      operationPrefix: "(root)",
      fileName: "dynamic.ts",
      line: 4,
      message: "Static analysis cannot prove capability operation for todos; capability grants must fail closed.",
    },
  ]);
});

test("rejects fabricated handles even when their visible fields match a real handle", async () => {
  const runtime = createCapabilityRuntime({
    grants: [
      {
        componentId: "api",
        importInterface: "wasi:keyvalue",
        resource: "todos",
        operations: ["get"],
      },
    ],
  });
  runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
  runtime.registerProvider({
    id: "local-kv",
    exports: {
      "wasi:keyvalue": {
        get: () => ({ value: "secret" }),
      },
    },
  });
  runtime.link({
    componentId: "api",
    importInterface: "wasi:keyvalue",
    providerId: "local-kv",
    exportInterface: "wasi:keyvalue",
  });
  const real = runtime.issueHandle({
    componentId: "api",
    importInterface: "wasi:keyvalue",
  });
  const forged = {
    componentId: real.componentId,
    importInterface: real.importInterface,
    token: real.token,
  };

  await assert.rejects(
    () => runtime.callWithHandle(forged, "get", { key: "secret" }),
    (error) =>
      error instanceof CapabilityDeniedError &&
      error.code === "capability.fabricated-handle",
  );
  assert.equal(runtime.events.some((event) => event.type === "link.Called"), false);
});

test("ambient provider reachability is not enough without link table entry", async () => {
  const runtime = createCapabilityRuntime({
    grants: [
      {
        componentId: "api",
        importInterface: "wasi:keyvalue",
        resource: "todos",
        operations: ["get"],
      },
    ],
  });
  runtime.registerComponent({ id: "api", imports: ["wasi:keyvalue"] });
  runtime.registerProvider({
    id: "local-kv",
    exports: {
      "wasi:keyvalue": {
        get: () => ({ value: "should-not-route" }),
      },
    },
  });
  const handle = runtime.issueHandle({
    componentId: "api",
    importInterface: "wasi:keyvalue",
  });

  await assert.rejects(
    () => runtime.callWithHandle(handle, "get", { key: "todo-1" }),
    (error) =>
      error instanceof CapabilityDeniedError &&
      error.code === "capability.no-linked-route",
  );
});
