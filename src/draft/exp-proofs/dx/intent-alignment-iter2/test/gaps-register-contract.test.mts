import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ITER2_EXPECTED,
  validateGapsFileFromRepo,
  validateIteration2Register,
} from "../src/gaps-register-contract.mts";

describe("intent-alignment iteration 2 GAPS register contract", () => {
  it("validates repo GAPS.md after iteration 2 append", () => {
    const result = validateGapsFileFromRepo(process.cwd());

    assert.deepEqual(result, { ok: true });
  });

  it("rejects register missing iteration 2 gap rows", () => {
    const result = validateIteration2Register("# GAPS\n| GAP-001 |", ITER2_EXPECTED);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("GAP-018")));
    }
  });
});
