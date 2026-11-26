import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  EXPECTED_RUNTIME_INTERFACES,
  SDK_PRIMITIVE_TABLE,
  assertMatchesSdkPrimitiveTable,
  assertNoNondeterministicWitContract,
  assertRuntimeWitContract,
  buildManifestFragment,
  readRuntimeWit,
  validateReplaySafety,
} from "../src/runtime-primitives.js";

const packageRoot = join(import.meta.dirname, "..");

test("runtime WIT declares every HOBO-13 primitive interface and jco emits guest bindings", async () => {
  const source = await readRuntimeWit();
  const contract = assertRuntimeWitContract(source);
  const generatedFiles = await readdir(join(packageRoot, "generated", "interfaces"));

  assert.deepEqual(Object.keys(contract.interfaces), [
    "workflow",
    "actor",
    "saga",
    "agent",
    "command",
    "subscribe",
  ]);

  for (const [interfaceName, expected] of Object.entries(EXPECTED_RUNTIME_INTERFACES)) {
    assert.deepEqual(contract.interfaces[interfaceName].functions, expected.functions);
    assert.ok(
      generatedFiles.some((file) => file.includes(`hobo-runtime-${interfaceName}`)),
      `${interfaceName} generated binding missing`,
    );
  }
});

test("no-op guest fixture imports every runtime primitive interface", async () => {
  const fixture = JSON.parse(
    await readFile(join(packageRoot, "fixtures", "noop-guest-imports.json"), "utf8"),
  );
  const manifest = buildManifestFragment(await readRuntimeWit());

  assert.equal(fixture.schema, "hobo.runtime.noop-guest-imports/v1");
  assert.deepEqual(fixture.imports, manifest.imports.map((entry) => entry.interface));
  assert.equal(fixture.exports.length, 0);
});

test("SDK primitive table cannot drift from the WIT signatures", async () => {
  const source = await readRuntimeWit();

  assertMatchesSdkPrimitiveTable(source);

  const driftedSource = source.replace("run-step: func", "run-step-v2: func");
  assert.throws(
    () => assertMatchesSdkPrimitiveTable(driftedSource),
    /runtime_primitives.signature_drift: step -> workflow.run-step/,
  );
});

test("replay-safety checklist rejects wall-clock or random primitives", async () => {
  const source = await readRuntimeWit();

  assertNoNondeterministicWitContract(source);
  assert.equal(validateReplaySafety(SDK_PRIMITIVE_TABLE).checked, SDK_PRIMITIVE_TABLE.length);

  assert.throws(
    () =>
      validateReplaySafety([
        ...SDK_PRIMITIVE_TABLE,
        {
          primitive: "wallClock",
          interface: "workflow",
          function: "now",
          replayClass: "wall-clock",
          deterministic: false,
        },
      ]),
    /runtime_primitives.nondeterministic_primitive: wallClock/,
  );
  assert.throws(
    () => assertNoNondeterministicWitContract(`${source}\n// wall-clock current-time random`),
    /runtime_primitives.nondeterministic_wit_shape/,
  );
});

test("manifest fragment records version and stability for every primitive import", async () => {
  const manifest = buildManifestFragment(await readRuntimeWit());

  assert.equal(manifest.schema, "hobo.manifest.fragment/runtime-primitives/v1");
  assert.equal(manifest.package, "hobo:runtime");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.world, "runtime-primitives");
  assert.ok(manifest.imports.every((entry) => entry.version === "0.1.0"));
  assert.ok(manifest.imports.every((entry) => entry.stability === "preview"));
});
