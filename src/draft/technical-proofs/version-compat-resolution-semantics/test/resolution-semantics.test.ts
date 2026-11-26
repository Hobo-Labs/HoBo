import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { canonicalResult, resolveVector } from "../src/resolution-semantics.js";

const vectorsPath = path.resolve(import.meta.dirname, "..", "fixtures", "resolution-vectors.json");
const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));

for (const vector of vectors) {
  test(vector.name, () => {
    const result = canonicalResult(resolveVector(vector));
    assert.deepEqual(result, vector.expected);

    if (vector.shuffleCatalog) {
      const reversed = {
        ...vector,
        catalog: [...vector.catalog].reverse()
      };
      assert.deepEqual(canonicalResult(resolveVector(reversed)), vector.expected);
    }
  });
}

test("fixture names stay unique for future resolver imports", () => {
  const names = vectors.map((vector) => vector.name);
  assert.equal(new Set(names).size, names.length);
});
