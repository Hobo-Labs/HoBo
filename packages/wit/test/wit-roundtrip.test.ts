import { describe, expect, it } from "vitest";

import { assertGeneratedMatches } from "../src/wit-gen.js";

describe("wit round-trip", () => {
	it("regenerates byte-identical bindings for every world", async () => {
		const result = await assertGeneratedMatches();
		expect(result.checked).toBeGreaterThan(0);
	}, 180_000);
});
