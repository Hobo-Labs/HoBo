import assert from "node:assert/strict";
import { test } from "vitest";

import {
  NoRouteError,
  ProviderHandlerStore,
  WireVersionIncompatibleError,
  createInProcessTransport,
  createWrpcLinkLayer,
  parseInterfaceId,
  parseWireVersion,
} from "../src/index.js";
import { type JsonValue } from "../src/json.js";


const KV = parseInterfaceId("wasi:keyvalue/store@1.2.0");
const FLOOR = "1.3.0";

function createTestLayer(floor = FLOOR) {
  const store = new ProviderHandlerStore();
  const transport = createInProcessTransport({ store });
  return createWrpcLinkLayer({ transport, compatibilityFloor: floor, store });
}

test("caller@N and provider@N+1 negotiate the highest shared minor before establishing the link", () => {
  const layer = createTestLayer("1.2.0");
  layer.registerComponent({
    id: "api",
    imports: [
      {
        interfaceId: KV,
        stability: "stable",
        versions: [parseWireVersion("1.2.0")],
      },
    ],
  });
  layer.registerProvider({
    id: "local-kv",
    exports: [
      {
        interfaceId: KV,
        stability: "stable",
        versions: [parseWireVersion("1.2.0"), parseWireVersion("1.3.0")],
      },
    ],
    handlers: { [KV]: { get: () => ({ value: "ok" }) } },
  });

  const link = layer.establishLink({
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV,
  });

  assert.equal(link.negotiatedWire.minor, "1.2");
  assert.equal(layer.events.at(-1)?.type, "link.Established");
});

test("a shared minor below the declared floor rejects the link with version-incompatible", async () => {
  let providerCalls = 0;
  const layer = createTestLayer(FLOOR);
  layer.registerComponent({
    id: "api",
    imports: [
      {
        interfaceId: KV,
        stability: "stable",
        versions: [parseWireVersion("1.2.0")],
      },
    ],
  });
  layer.registerProvider({
    id: "local-kv",
    exports: [
      {
        interfaceId: KV,
        stability: "stable",
        versions: [parseWireVersion("1.2.5")],
      },
    ],
    handlers: {
      [KV]: {
        get() {
          providerCalls += 1;
          return { value: "should-not-run" };
        },
      },
    },
  });

  assert.throws(
    () =>
      layer.establishLink({
        componentId: "api",
        importInterface: KV,
        providerId: "local-kv",
        exportInterface: KV,
      }),
    (error: JsonValue) =>
      error instanceof WireVersionIncompatibleError &&
      error.code === "version-incompatible" &&
      error.reason === "shared-minor-below-floor" &&
      error.phase === "link-establishment",
  );
  assert.equal(
    layer.events.some((event) => event.type === "link.Rejected"),
    true,
  );
  assert.equal(providerCalls, 0);

  await assert.rejects(
    () => layer.callImport("api", KV, "get", { key: "session" }),
    (error: JsonValue) => error instanceof NoRouteError,
  );
});

test("no shared minor at all rejects with version-incompatible no-shared-minor", () => {
  const layer = createTestLayer("1.2.0");
  layer.registerComponent({
    id: "api",
    imports: [
      {
        interfaceId: KV,
        stability: "stable",
        versions: [parseWireVersion("1.2.0")],
      },
    ],
  });
  layer.registerProvider({
    id: "local-kv",
    exports: [
      {
        interfaceId: KV,
        stability: "stable",
        versions: [parseWireVersion("2.0.0")],
      },
    ],
    handlers: { [KV]: { get: () => ({ value: "nope" }) } },
  });

  assert.throws(
    () =>
      layer.establishLink({
        componentId: "api",
        importInterface: KV,
        providerId: "local-kv",
        exportInterface: KV,
      }),
    (error: JsonValue) =>
      error instanceof WireVersionIncompatibleError &&
      error.reason === "no-shared-minor",
  );
});
