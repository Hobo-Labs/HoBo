import { describe, expect, it } from "vitest";

import { createBareMetalProvider } from "../src/local-provider.js";

describe("local Yard ports", () => {
	it("advertises kv and queue so shop-class Bindles can plan locally", () => {
		const ports = createBareMetalProvider().capabilities.map(
			(capability) => capability.port,
		);
		expect(ports).toEqual(expect.arrayContaining(["kv", "queue"]));
	});
});
