import assert from "node:assert/strict";
import { test } from "vitest";

import {
  EXPECTED_ROUND_TRIP_INTERFACES,
  WIT_VENDOR_ROOT,
  buildManifestFragment,
  roundTripFixture,
  verifyPinnedInterfaces,
} from "../src/wasi-pins.js";

test("vendored WASI pins verify against their recorded hashes", async () => {
  const verified = await verifyPinnedInterfaces();

  assert.equal(verified.interfaces.length, 13);
  assert.equal(verified.manifest.schema, "hobo.manifest.fragment/wasi-pins/v1");
  assert.equal(verified.manifest.imports.length, verified.interfaces.length);

  for (const entry of verified.interfaces) {
    assert.match(entry.digest, /^sha256:[a-f0-9]{64}$/);
    assert.match(entry.path, /^wit\/vendor\/wasi-/);
    assert.equal(entry.verified, true);
  }
});

test("hash drift fails closed before a vendored WASI interface can be used", async () => {
  const [{ interfaceRef, digest }] = (await verifyPinnedInterfaces()).interfaces;
  const driftedDigest = digest.endsWith("0")
    ? `${digest.slice(0, -1)}1`
    : `${digest.slice(0, -1)}0`;

  await assert.rejects(
    () =>
      verifyPinnedInterfaces({
        overrides: {
          [interfaceRef]: {
            digest: driftedDigest,
          },
        },
      }),
    /wasi_pin.hash_drift/
  );
});

test("round-trip conformance fixtures preserve kv, blob, messaging, config, and logging shapes", async () => {
  assert.deepEqual(EXPECTED_ROUND_TRIP_INTERFACES, [
    "wasi:keyvalue/store@0.2.0",
    "wasi:blobstore/blobstore@0.2.0",
    "wasi:messaging/messaging@0.2.0",
    "wasi:config/store@0.2.0",
    "wasi:logging/logging@0.2.0",
  ]);

  for (const interfaceRef of EXPECTED_ROUND_TRIP_INTERFACES) {
    const result = await roundTripFixture(interfaceRef);

    assert.equal(result.interfaceRef, interfaceRef);
    assert.deepEqual(result.decoded, result.input);
    assert.equal(result.link.providerExport, interfaceRef);
    assert.equal(result.link.bound, true);
  }
});

test("round-trip use also fails closed when a vendored WIT hash drifts", async () => {
  const [pin] = (await verifyPinnedInterfaces()).interfaces;

  await assert.rejects(
    () =>
      roundTripFixture("wasi:keyvalue/store@0.2.0", {
        overrides: {
          [pin.interfaceRef]: {
            digest: pin.digest.endsWith("0")
              ? `${pin.digest.slice(0, -1)}1`
              : `${pin.digest.slice(0, -1)}0`,
          },
        },
      }),
    /wasi_pin.hash_drift/
  );
});

test("manifest fragment records interface version and stability for every pin", async () => {
  const fragment = await buildManifestFragment({ vendorRoot: WIT_VENDOR_ROOT });

  assert.equal(fragment.componentHost.kind, "component-host");
  assert.equal(fragment.componentHost.host, "wasmtime");
  assert.equal(fragment.imports.length, 13);
  assert.ok(fragment.imports.every((entry) => entry.version === "0.2.0"));
  assert.ok(fragment.imports.every((entry) => entry.stability === "preview"));
  assert.ok(fragment.imports.every((entry) => entry.digest.startsWith("sha256:")));
});

test("unknown or unlinked interfaces cannot pass the round-trip fixture", async () => {
  await assert.rejects(
    () => roundTripFixture("wasi:websocket/types@0.0.1-draft"),
    /wasi_roundtrip.unlinked_interface/
  );
});
