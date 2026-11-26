import assert from "node:assert/strict";
import { test } from "vitest";

import {
  NoRouteError,
  createInProcessWrpcMembrane
} from "../src/wrpc-in-process-link.js";

const KV = "wasi:keyvalue/store@0.2.0";
const BLOB = "wasi:blobstore/blobstore@0.2.0";

test("linked WIT import routes to a provider export through the in-process wRPC membrane", async () => {
  const membrane = createInProcessWrpcMembrane();
  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "local-kv",
    exports: {
      [KV]: {
        get: ({ key }) => ({ value: `stored:${key}` })
      }
    }
  });

  const link = membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV
  });
  const result = await membrane.callImport("api", KV, "get", { key: "session" }, {
    deadline: "2026-06-25T15:45:00.000Z"
  });

  assert.equal(link.boundaryMode, "live");
  assert.equal(link.transport, "in-process");
  assert.deepEqual(result, { value: "stored:session" });
  assert.deepEqual(membrane.events.at(-1), {
    type: "link.Called",
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV,
    operation: "get",
    boundaryMode: "live",
    transport: "in-process",
    deadline: "2026-06-25T15:45:00.000Z",
    codec: "json-wit"
  });
});

test("unlinked imports fail with typed no-route instead of panicking", async () => {
  const membrane = createInProcessWrpcMembrane();
  membrane.registerComponent({ id: "worker", imports: [KV] });
  membrane.registerProvider({
    id: "local-kv",
    exports: {
      [KV]: {
        get: () => ({ value: "should-not-route" })
      }
    }
  });

  await assert.rejects(
    () => membrane.callImport("worker", KV, "get", { key: "session" }),
    (error) => error instanceof NoRouteError && error.code === "no-route"
  );
  assert.equal(membrane.events.some((event) => event.type === "link.Called"), false);
});

test("a provider export cannot be reached unless the exact import is in the link table", async () => {
  const membrane = createInProcessWrpcMembrane();
  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "storage-provider",
    exports: {
      [KV]: {
        get: () => ({ value: "kv" })
      },
      [BLOB]: {
        read: () => ({ bytes: [1, 2, 3] })
      }
    }
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "storage-provider",
    exportInterface: KV
  });

  await assert.rejects(
    () => membrane.callImport("api", BLOB, "read", { key: "secret" }),
    (error) => error instanceof NoRouteError && error.routeKey === `api\0${BLOB}`
  );
});

test("report records HOBO-18 scope and explicitly excludes later membrane semantics", () => {
  const membrane = createInProcessWrpcMembrane();

  assert.deepEqual(membrane.report(), {
    schema: "hobo.wrpc.in-process-link/v1",
    issue: "HOBO-18",
    supportedTransports: ["in-process"],
    boundaryModeDefault: "live",
    events: ["link.Established", "link.Called"],
    scopeIn: [
      "WIT-shaped encode-route-decode call abstraction",
      "link table import-to-provider-export routing",
      "typed no-route error for missing links",
      "link.Called event with deadline field present"
    ],
    scopeOut: [
      "NATS/JetStream lattice transport",
      "deadline enforcement",
      "backpressure handling",
      "partial or ambiguous failure taxonomy",
      "wire-version negotiation"
    ]
  });
});
