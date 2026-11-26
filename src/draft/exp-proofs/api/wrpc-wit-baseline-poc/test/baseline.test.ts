import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

const root = join(import.meta.dirname, "..");

test("baseline world generates a typed smoke interface", async () => {
  const baselineTypes = await readFile(
    join(root, "generated", "interfaces", "hobo-wrpc-baseline-baseline.d.ts"),
    "utf8",
  );

  assert.match(baselineTypes, /export interface InterfacePin/);
  assert.match(baselineTypes, /export interface WrpcLink/);
  assert.match(baselineTypes, /export function smokeCall/);
  assert.match(baselineTypes, /importInterface: string/);
  assert.match(baselineTypes, /providerExport: string/);
});

test("lock records exact pins and preview upcaster discipline", async () => {
  const lock = JSON.parse(await readFile(join(root, "toolchain-lock.json"), "utf8"));

  assert.equal(lock.manifestFloor.componentModel, "wasmtime@46.0.1");
  assert.equal(lock.manifestFloor.defaultTransport, "wrpc@0.17.0+nats");
  assert.equal(lock.manifestFloor["interfacePinShape"], "namespace:package/interface@semver@stability");
  assert.ok(lock.ciGuards.includes("vendored-interface-sha256-matches-lock"));
  assert.ok(lock.ciGuards.includes("wit-bindgen-cli-resolves-baseline-world"));
  assert.ok(lock.ciGuards.includes("preview-bump-declares-upcaster"));
});
