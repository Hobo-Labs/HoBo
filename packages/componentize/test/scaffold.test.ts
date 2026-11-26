import { describe, expect, it } from "vitest";

import { HOBO_COMPONENTIZE_PACKAGE } from "../src/index.js";

describe("@hobo/componentize scaffold", () => {
	it("exports the package name constant", () => {
		expect(HOBO_COMPONENTIZE_PACKAGE).toBe("@hobo/componentize");
	});
});
