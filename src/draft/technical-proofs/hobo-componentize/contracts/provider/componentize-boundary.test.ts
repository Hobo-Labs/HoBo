import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runComponentSmoke, validateWasmComponentArtifact } from "../../src/index.js";
import { buildHelloBindle, componentizeRealBuildSkipReason } from "../../test/helpers.js";

const pactPath = fileURLToPath(
  new URL("../pacts/componentize-build-boundary.pact.json", import.meta.url),
);

test(
  "verifies the provider response envelope",
  { skip: componentizeRealBuildSkipReason ?? false },
  async () => {
    const pact = JSON.parse(await readFile(pactPath, "utf8"));
    const expected = pact.interactions[0].response.body;
    const result = await buildHelloBindle();
    const validation = validateWasmComponentArtifact(result.component);
    const smoke = await runComponentSmoke(result.component, { exportName: "health" });

    assert.equal(validation.passed, expected.validation.passed);
    assert.equal(smoke.exitCode, expected.smoke.exitCode);
    assert.equal(result.oci.manifest.mediaType, expected.oci.mediaType);
  },
);
