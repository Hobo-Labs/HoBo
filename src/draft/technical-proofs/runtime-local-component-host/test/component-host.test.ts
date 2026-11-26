import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ComponentTrapError,
  createRuntimeLocalComponentHost,
  createWasmtimeEngineStub,
} from "../src/component-host.js";

test("runtime-local host runs an HTTP component through a static in-process link table", async () => {
  const host = createRuntimeLocalComponentHost({
    engine: createWasmtimeEngineStub({ version: "wasmtime-stub/0.1.0" }),
  });

  host.registerProvider({
    id: "local-http",
    exports: {
      "wasi:http/outgoing-handler@0.2.0": {
        handle: async (request) => ({
          status: 200,
          headers: [["x-provider", "runtime-local"]],
          body: `provider:${request.path}`,
        }),
      },
    },
  });

  host.loadComponent({
    id: "api",
    imports: ["wasi:http/outgoing-handler@0.2.0"],
    exports: {
      "wasi:http/incoming-handler@0.2.0": {
        handle: async (request, context) => {
          const upstream = await context.callImport("wasi:http/outgoing-handler@0.2.0", "handle", request);
          return {
            status: upstream.status,
            headers: upstream.headers,
            body: `guest:${upstream.body}`,
          };
        },
      },
    },
  });

  host.link({
    componentId: "api",
    importInterface: "wasi:http/outgoing-handler@0.2.0",
    providerId: "local-http",
    exportInterface: "wasi:http/outgoing-handler@0.2.0",
  });

  const response = await host.handleHttp("api", {
    method: "GET",
    path: "/healthz",
    headers: [],
    body: "",
  });

  assert.deepEqual(response, {
    status: 200,
    headers: [["x-provider", "runtime-local"]],
    body: "guest:provider:/healthz",
  });
  assert.deepEqual(
    host.events.map((event) => event.type),
    ["component.Loaded", "link.Established", "link.Called", "component.Invoked"],
  );
  assert.equal(host.engine.kind, "wasmtime");
});

test("link table supports direct in-process import-to-export invocation", async () => {
  const host = createRuntimeLocalComponentHost();
  host.registerProvider({
    id: "clock",
    exports: {
      "wasi:clocks/monotonic-clock@0.2.0": {
        now: () => ({ nanoseconds: 123n }),
      },
    },
  });
  host.loadComponent({
    id: "worker",
    imports: ["wasi:clocks/monotonic-clock@0.2.0"],
    exports: {},
  });
  host.link({
    componentId: "worker",
    importInterface: "wasi:clocks/monotonic-clock@0.2.0",
    providerId: "clock",
    exportInterface: "wasi:clocks/monotonic-clock@0.2.0",
  });

  const value = await host.invokeLinkedImport("worker", "wasi:clocks/monotonic-clock@0.2.0", "now");

  assert.deepEqual(value, { nanoseconds: 123n });
  assert.equal(host.events.at(-1).type, "link.Called");
  assert.equal(host.events.at(-1).boundaryMode, "in-process");
});

test("component traps fail the call without taking down the host", async () => {
  const host = createRuntimeLocalComponentHost();
  host.loadComponent({
    id: "bad-api",
    imports: [],
    exports: {
      "wasi:http/incoming-handler@0.2.0": {
        handle: () => {
          throw new Error("guest panic");
        },
      },
    },
  });
  host.loadComponent({
    id: "healthy-api",
    imports: [],
    exports: {
      "wasi:http/incoming-handler@0.2.0": {
        handle: () => ({ status: 204, headers: [], body: "" }),
      },
    },
  });

  await assert.rejects(
    () => host.handleHttp("bad-api", { method: "GET", path: "/panic", headers: [], body: "" }),
    ComponentTrapError,
  );

  assert.deepEqual(
    await host.handleHttp("healthy-api", { method: "GET", path: "/ok", headers: [], body: "" }),
    { status: 204, headers: [], body: "" },
  );
  assert.equal(host.lifecycle("bad-api").state, "loaded");
  assert.equal(host.events.some((event) => event.type === "component.Trapped"), true);
});

test("teardown releases leases and removes routes for unloaded components", async () => {
  const host = createRuntimeLocalComponentHost();
  host.registerProvider({
    id: "kv",
    exports: {
      "wasi:keyvalue/store@0.2.0": {
        get: () => "value",
      },
    },
  });
  host.loadComponent({
    id: "uses-kv",
    imports: ["wasi:keyvalue/store@0.2.0"],
    exports: {},
    leases: ["memory:uses-kv", "fd:fixture"],
  });
  host.link({
    componentId: "uses-kv",
    importInterface: "wasi:keyvalue/store@0.2.0",
    providerId: "kv",
    exportInterface: "wasi:keyvalue/store@0.2.0",
  });

  assert.equal(host.activeLeases().length, 2);
  await host.teardownComponent("uses-kv");

  assert.deepEqual(host.activeLeases(), []);
  assert.equal(host.linkTable().length, 0);
  assert.throws(
    () => host.invokeLinkedImport("uses-kv", "wasi:keyvalue/store@0.2.0", "get"),
    /component_host.component_not_loaded: uses-kv/,
  );
});

test("host report records HOBO-17 boundaries and fuel epoch follow-up", () => {
  const host = createRuntimeLocalComponentHost();

  assert.deepEqual(host.report(), {
    schema: "hobo.component-host.runtime-local/v1",
    hostKind: "runtime-local",
    engine: "wasmtime",
    supportedBoundaryModes: ["in-process"],
    scopeIn: [
      "component lifecycle",
      "static link table",
      "wasi:http incoming-handler demo",
      "trap isolation",
      "clean teardown",
    ],
    scopeOut: [
      "cross-process lattice transport",
      "container packaging",
      "deny-by-default grant inference",
      "deterministic-clock replay",
    ],
    followUps: ["fuel/epoch execution limits"],
  });
});
