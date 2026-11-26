import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { sortKeys } from "../src/sort-keys.js";
import { collectBindleResources } from "../src/index.js";
import { defineHelloBindle } from "./fixtures/hello-bindle-collector-target.js";

const here = dirname(fileURLToPath(import.meta.url));
// Local golden for this engine's collector-target output. The shared example
// manifest (examples/hello-bindle/contracts/manifests) was repurposed by the
// S1-15 bind-wiring promotion to a different bindle shape that other proofs
// consume, so this proof pins its own copy to stay byte-stable.
const fixturePath = join(here, "fixtures/hello-bindle.manifest.json");

function serializeCanonicalManifest(manifest) {
  return `${JSON.stringify(sortKeys(manifest), null, 2)}\n`;
}

describe("hello-bindle golden manifest", () => {
  it("collects hello-bindle into a byte-stable golden manifest", () => {
    const input = {
      bindleId: "hello-bindle",
      fileName: "bindle.ts",
      define: defineHelloBindle,
    };
    const first = collectBindleResources(input);
    const second = collectBindleResources(input);
    const serialized = serializeCanonicalManifest(first.manifest);

    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(fixturePath, serialized, "utf8");
    }

    const golden = readFileSync(fixturePath);
    assert.equal(Buffer.compare(Buffer.from(serialized, "utf8"), golden), 0);
    assert.equal(
      first.manifestHash,
      "sha256:cf9b2ce9cf6621bd747f0c2f10bfba36ac4a956ddc235ee591280d4772c5e87e",
    );
    assert.equal(first.manifestHash, second.manifestHash);
    assert.deepEqual(first.events, second.events);
  });
});
