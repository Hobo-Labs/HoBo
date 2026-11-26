import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("cli-dev-runtime-local pact", () => {
  it("loads consumer/provider boundary for CLI to runtime-local", () => {
    const pact = JSON.parse(
      readFileSync(join(here, "..", "contracts", "cli-dev-runtime-local.pact.json"), "utf8"),
    );
    assert.equal(pact.consumer.name, "@hobo/cli-dev");
    assert.equal(pact.provider.name, "@hobo/runtime-local");
    assert.equal(pact.interactions.length >= 3, true);
    assert.equal(pact.metadata.pactSpecification.version, "3.0.0");
  });
});

describe("cli-dev-codegen pact", () => {
  it("loads consumer/provider boundary for CLI to codegen engine", () => {
    const pact = JSON.parse(
      readFileSync(join(here, "..", "contracts", "cli-dev-codegen.pact.json"), "utf8"),
    );
    assert.equal(pact.consumer.name, "@hobo/cli-dev");
    assert.equal(pact.provider.name, "@hobo/codegen-engine");
    assert.equal(pact.interactions.some((i: { request: { path: string } }) => i.request.path === "/codegen/generate"), true);
    assert.equal(pact.interactions.some((i: { request: { path: string } }) => i.request.path === "/codegen/check"), true);
  });
});
