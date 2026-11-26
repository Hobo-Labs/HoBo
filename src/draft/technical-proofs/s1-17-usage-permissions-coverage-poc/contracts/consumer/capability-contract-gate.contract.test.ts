import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  buildUsagePermissionManifest,
  parseUsagePermissionInput,
} from "../../src/usage-permissions.js";

const pactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "capability-contract-gate.pact.json",
);

test("capability-contract-gate pact satisfies the 422 capability.required-not-granted interaction", () => {
  const pact = JSON.parse(readFileSync(pactPath, "utf8"));
  const interaction = pact.interactions[0];

  assert.equal(pact.consumer.name, "SdkAuthoringReferenceApp");
  assert.equal(pact.provider.name, "CapabilityContractGate");
  assert.equal(interaction.response.status, 422);
  assert.equal(interaction.response.body.reason, "capability.required-not-granted");

  const { manifest } = buildUsagePermissionManifest(
    parseUsagePermissionInput({
      bindle: "support-sync",
      resources: [
        {
          kind: "kv",
          name: "profile-cache",
          port: "wasi:keyvalue",
          catalogVerbs: ["get", "set"],
          observedCalls: [
            { verb: "get", source: "handler" },
            { verb: "set", source: "handler" },
          ],
          declaredAllow: interaction.request.body.granted,
        },
      ],
    }),
  );

  const [resource] = manifest.resources;
  assert.deepEqual(resource?.capabilityContract.required, interaction.request.body.required);
  assert.deepEqual(resource?.capabilityContract.granted, interaction.request.body.granted);
  assert.equal(
    resource?.capabilityContract.failures[0]?.code,
    interaction.response.body.reason,
  );
});
