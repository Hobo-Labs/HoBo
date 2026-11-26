import { parseResourceId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createLocalBindingResolver,
	HELLO_BINDLE_LOCAL_ENDPOINTS,
} from "../src/binding-resolver.js";

describe("createLocalBindingResolver()", () => {
	it("resolves known resource properties", async () => {
		const resolver = createLocalBindingResolver(HELLO_BINDLE_LOCAL_ENDPOINTS);
		const binding = await resolver.resolve(
			parseResourceId("db"),
			"connectionString",
		);

		expect(binding.source).toBe("runtime-local");
		expect(binding.value).toMatch(/^sqlite:\/\//);
	});

	it("rejects unknown resource properties", async () => {
		const resolver = createLocalBindingResolver(HELLO_BINDLE_LOCAL_ENDPOINTS);

		await expect(
			resolver.resolve(parseResourceId("db"), "missing"),
		).rejects.toThrow(/unknown binding db\.missing/);
		await expect(
			resolver.resolve(parseResourceId("ghost"), "connectionString"),
		).rejects.toThrow(/unknown binding ghost\.connectionString/);
	});
});
