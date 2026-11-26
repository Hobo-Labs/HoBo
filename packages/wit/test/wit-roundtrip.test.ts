import { describe, expect, it } from "vitest";

import { assertGeneratedMatches } from "../src/wit-gen.js";

describe("wit round-trip", () => {
	// Regenerates all worlds through jco; scales with GENERATION_TARGETS and
	// runs slower under a fully parallel workspace test sweep, so it carries
	// its own budget instead of the 10s default.
	it("regenerates byte-identical bindings for every world", async () => {
		const result = await assertGeneratedMatches();
		expect(result.checked).toBeGreaterThan(0);
	}, 180_000);
});
