import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { runHoboYardUp } from "../../src/yard-shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pactPath = path.resolve(__dirname, "..", "..", "architecture", "pacts", "gateway_boundary.pact.json");

describe("gateway boundary consumer pact", () => {
  it("verifies CloudYardGateway provider interactions", async () => {
    const pact = JSON.parse(await readFile(pactPath, "utf8"));
    const yard = runHoboYardUp();
    let deployed = false;

    for (const interaction of pact.interactions) {
      if (interaction.request.method === "POST") {
        const response = yard.gateway.handleRest({
          method: interaction.request.method,
          path: interaction.request.path,
          headers: interaction.request.headers,
          body: interaction.request.body,
        });
        assert.equal(response.status, interaction.response.status);
        assert.deepEqual(response.body, interaction.response.body);
        deployed = true;
        continue;
      }

      if (interaction.request.method === "GET") {
        assert.equal(deployed, true, "timeline read requires prior deploy command");
        const response = yard.gateway.handleRest({
          method: interaction.request.method,
          path: interaction.request.path,
          query: interaction.request.query,
        });
        const { entries, ...body } = response.body;
        assert.equal(response.status, interaction.response.status);
        assert.deepEqual(body, interaction.response.body);
        assert.ok(Array.isArray(entries) && entries.length >= 1);
      }
    }
  });
});
