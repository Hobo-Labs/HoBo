import { describe, expect, it } from "vitest";

import { HOBO_CONFORMANCE_PACKAGE } from "../src/index.js";

describe("@hobo/conformance scaffold", () => {
	it("exports the package name constant", () => {
		expect(HOBO_CONFORMANCE_PACKAGE).toBe("@hobo/conformance");
	});
});
