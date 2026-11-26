import { describe, expect, it } from "vitest";

import { stableStringify } from "../src/json.js";

// Regression: the two private copies of stableStringify diverged — the
// sources.ts copy was a bare JSON.stringify (insertion-order dependent) and
// the oci.ts copy checked isJsonObject before Array.isArray, so objects
// nested inside arrays were never key-sorted (the array branch was dead
// code). Digests derived from either copy were only accidentally stable.
describe("stableStringify", () => {
  it("is independent of object key insertion order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(
      stableStringify({ a: 2, b: 1 }),
    );
  });

  it("sorts keys of objects nested inside arrays", () => {
    const left = stableStringify({ sources: [{ path: "a.ts", digest: "x" }] });
    const right = stableStringify({ sources: [{ digest: "x", path: "a.ts" }] });
    expect(left).toBe(right);
  });

  it("preserves array element order", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("accepts readonly (frozen) inputs without mutating them", () => {
    const frozen = Object.freeze({
      sources: Object.freeze([Object.freeze({ path: "a.ts", digest: "x" })]),
    });
    expect(stableStringify(frozen)).toBe(
      '{"sources":[{"digest":"x","path":"a.ts"}]}',
    );
  });
});
