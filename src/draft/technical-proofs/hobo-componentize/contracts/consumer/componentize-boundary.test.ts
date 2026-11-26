import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHelloBindle, componentizeRealBuildSkipReason } from "../../test/helpers.js";

const pactPath = fileURLToPath(
  new URL("../pacts/componentize-build-boundary.pact.json", import.meta.url),
);

test(
  "matches the componentize-build-boundary interaction",
  { skip: componentizeRealBuildSkipReason ?? false },
  async () => {
    const pact = JSON.parse(await readFile(pactPath, "utf8"));
    const interaction = pact.interactions[0];
    const result = await buildHelloBindle();

    assert.equal(interaction.request.method, "POST");
    assert.equal(interaction.request.path, "/componentize/hello-bindle");
    assert.equal(result.oci.manifest.mediaType, interaction.response.body.oci.mediaType);
    assert.equal(interaction.response.body.validation.passed, true);
    assert.equal(interaction.response.body.smoke.exitCode, 0);
  },
);
