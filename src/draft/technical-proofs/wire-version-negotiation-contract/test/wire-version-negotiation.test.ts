import assert from "node:assert/strict";
import { test } from "vitest";

import {
  WireVersionIncompatibleError,
  createWireVersionLinker
} from "../src/wire-version-negotiation.js";

const KV = "wasi:keyvalue/store";
const FLOOR = "0.2.0";

test("caller@N and provider@N+1 negotiate the highest shared minor before establishing the link", () => {
  const linker = createWireVersionLinker({ compatibilityFloor: FLOOR });
  linker.registerComponent({
    id: "api",
    imports: [{ interfaceId: KV, versions: ["0.2.0"], stability: "stable" }]
  });
  linker.registerProvider({
    id: "local-kv",
    exports: [{ interfaceId: KV, versions: ["0.2.0", "0.3.0"], stability: "stable" }]
  });

  const link = linker.establishLink({
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV
  });

  assert.deepEqual(link.negotiatedWire, {
    interfaceId: KV,
    version: "0.2.0",
    minor: "0.2",
    stability: "stable",
    floor: FLOOR
  });
  assert.deepEqual(linker.manifestIr().links[0].wire, link.negotiatedWire);
  assert.equal(linker.events.at(-1).type, "link.Established");
});

test("a shared minor below the declared floor rejects the link with version-incompatible", () => {
  const linker = createWireVersionLinker({ compatibilityFloor: FLOOR });
  linker.registerComponent({
    id: "old-api",
    imports: [{ interfaceId: KV, versions: ["0.1.0"], stability: "stable" }]
  });
  linker.registerProvider({
    id: "old-provider",
    exports: [{ interfaceId: KV, versions: ["0.1.3"], stability: "stable" }]
  });

  assert.throws(
    () => linker.establishLink({
      componentId: "old-api",
      importInterface: KV,
      providerId: "old-provider",
      exportInterface: KV
    }),
    (error) =>
      error instanceof WireVersionIncompatibleError &&
      error.code === "version-incompatible" &&
      error.phase === "link-establishment" &&
      error.reason === "shared-minor-below-floor"
  );
  assert.equal(linker.manifestIr().links.length, 0);
  assert.equal(linker.events.some((event) => event.type === "link.Established"), false);
});

test("mismatched wire versions fail at link time instead of being discovered by a first call", () => {
  let providerCalls = 0;
  const linker = createWireVersionLinker({ compatibilityFloor: FLOOR });
  linker.registerComponent({
    id: "api",
    imports: [{ interfaceId: KV, versions: ["0.2.0"], stability: "stable" }]
  });
  linker.registerProvider({
    id: "kv-v3",
    exports: [{ interfaceId: KV, versions: ["0.3.0"], stability: "stable" }],
    handlers: {
      [KV]: {
        get() {
          providerCalls += 1;
          return { value: "silent-coercion-would-be-wrong" };
        }
      }
    }
  });

  assert.throws(
    () => linker.establishLink({
      componentId: "api",
      importInterface: KV,
      providerId: "kv-v3",
      exportInterface: KV
    }),
    (error) =>
      error instanceof WireVersionIncompatibleError &&
      error.reason === "no-shared-minor" &&
      error.phase === "link-establishment"
  );
  assert.throws(
    () => linker.callImport("api", KV, "get", { key: "session" }),
    /wrpc.no_route: api:wasi:keyvalue\/store/
  );
  assert.equal(providerCalls, 0);
});

test("report records HOBO-26 scope and excludes floor policy, upcasters, and lattice transport", () => {
  const linker = createWireVersionLinker({ compatibilityFloor: FLOOR });

  assert.deepEqual(linker.report(), {
    schema: "hobo.wrpc.wire-version-negotiation/v1",
    issue: "HOBO-26",
    compatibilityFloor: FLOOR,
    events: ["link.Established", "link.Rejected"],
    errors: ["version-incompatible"],
    scopeIn: [
      "highest shared minor negotiation at link establishment",
      "below-floor link rejection with a typed version-incompatible error",
      "negotiated minor recorded in link.Established and manifest IR",
      "mismatch rejected before any provider call can be made"
    ],
    scopeOut: [
      "compatibility floor policy selection",
      "preview or experimental upcasters",
      "NATS/JetStream lattice transport details",
      "deadline, backpressure, or partial-failure handling"
    ]
  });
});
