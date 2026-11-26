import assert from "node:assert/strict";
import { test } from "vitest";

import { buildHelloBindleEvidence, smokeHealthExport } from "../src/build.ts";

const BUILD_COUNT = 3;

test("inputsDigest and smoke stay stable across clean componentize-js rebuilds", async () => {
  const results = [];
  for (let i = 0; i < BUILD_COUNT; i++) {
    results.push(await buildHelloBindleEvidence());
  }

  const inputsDigests = new Set(results.map((r) => r.inputsDigest));
  assert.equal(inputsDigests.size, 1, "inputsDigest must be identical for identical spec + sources");

  const smokes = [];
  for (const result of results) {
    smokes.push(await smokeHealthExport(result.bytes));
  }
  assert.ok(smokes.every((stdout) => stdout === "hello-bindle:ok\n"));
}, 360_000);

test("componentize-js@0.21.0 wasm bytes are not byte-identical across clean rebuilds (HOBO-603)", async () => {
  const digests: string[] = [];
  for (let i = 0; i < BUILD_COUNT; i++) {
    const result = await buildHelloBindleEvidence();
    digests.push(result.digest);
  }

  const unique = new Set(digests);
  assert.ok(
    unique.size > 1,
    `expected nondeterministic wasm digests from componentize-js; got identical: ${digests[0]}`,
  );
}, 360_000);

test("adversarial: trade-off is explicit — inputs gate passes while byte gate fails", async () => {
  const first = await buildHelloBindleEvidence();
  const second = await buildHelloBindleEvidence();

  assert.equal(second.inputsDigest, first.inputsDigest);

  const firstSmoke = await smokeHealthExport(first.bytes);
  const secondSmoke = await smokeHealthExport(second.bytes);
  assert.equal(secondSmoke, firstSmoke);

  if (second.digest === first.digest) {
    assert.fail(
      "byte-identical wasm unexpectedly returned; revisit ADR-0105 if upstream fixed reproducibility",
    );
  }
}, 360_000);
