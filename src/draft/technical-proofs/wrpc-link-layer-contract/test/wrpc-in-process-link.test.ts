import assert from "node:assert/strict";
import { test } from "vitest";

import {
  NoRouteError,
  ProviderHandlerStore,
  createInProcessTransport,
  createJsonWitCodec,
  createWrpcLinkLayer,
  parseInterfaceId,
  parseWireVersion,
} from "../src/index.js";
import { type JsonValue } from "../src/json.js";


const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const BLOB = parseInterfaceId("wasi:blobstore/blobstore@0.2.0");
const FLOOR = "0.2.0";

function createTestLayer() {
  const store = new ProviderHandlerStore();
  const transport = createInProcessTransport({ store, codec: createJsonWitCodec() });
  return createWrpcLinkLayer({ transport, compatibilityFloor: FLOOR, store });
}

function kvPin() {
  return {
    interfaceId: KV,
    stability: "stable" as const,
    versions: [parseWireVersion("0.2.0")],
  };
}

test("linked WIT import routes to a provider export through the in-process wRPC membrane", async () => {
  const layer = createTestLayer();
  layer.registerComponent({ id: "api", imports: [kvPin()] });
  layer.registerProvider({
    id: "local-kv",
    exports: [kvPin()],
    handlers: {
      [KV]: {
        get: ({ key }: { key: string }) => ({ value: `stored:${key}` }),
      },
    },
  });

  const link = layer.establishLink({
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV,
  });
  const result = await layer.callImport("api", KV, "get", { key: "session" }, {
    deadline: "2026-06-25T15:45:00.000Z",
  });

  assert.equal(link.boundaryMode, "live");
  assert.equal(link.transport, "in-process");
  assert.deepEqual(result, { value: "stored:session" });
  assert.deepEqual(layer.events.at(-1), {
    type: "link.Called",
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV,
    operation: "get",
    boundaryMode: "live",
    transport: "in-process",
    deadline: "2026-06-25T15:45:00.000Z",
    codec: "json-wit",
  });
});

test("unlinked imports fail with typed no-route instead of panicking", async () => {
  const layer = createTestLayer();
  layer.registerComponent({ id: "worker", imports: [kvPin()] });
  layer.registerProvider({
    id: "local-kv",
    exports: [kvPin()],
    handlers: {
      [KV]: {
        get: () => ({ value: "should-not-route" }),
      },
    },
  });

  await assert.rejects(
    () => layer.callImport("worker", KV, "get", { key: "session" }),
    (error: JsonValue) => error instanceof NoRouteError && error.code === "no-route",
  );
  assert.equal(layer.events.some((event) => event.type === "link.Called"), false);
});

test("a provider export cannot be reached unless the exact import is in the link table", async () => {
  const layer = createTestLayer();
  const blobPin = {
    interfaceId: BLOB,
    stability: "stable" as const,
    versions: [parseWireVersion("0.2.0")],
  };
  layer.registerComponent({ id: "api", imports: [kvPin()] });
  layer.registerProvider({
    id: "storage-provider",
    exports: [kvPin(), blobPin],
    handlers: {
      [KV]: { get: () => ({ value: "kv" }) },
      [BLOB]: { read: () => ({ bytes: [1, 2, 3] }) },
    },
  });
  layer.establishLink({
    componentId: "api",
    importInterface: KV,
    providerId: "storage-provider",
    exportInterface: KV,
  });

  await assert.rejects(
    () => layer.callImport("api", BLOB, "read", { key: "secret" }),
    (error: JsonValue) =>
      error instanceof NoRouteError && error.routeKey === `api\0${BLOB}`,
  );
});
