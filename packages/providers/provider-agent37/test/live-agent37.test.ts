import { describe, expect, it } from "vitest";
import { createAgent37Client } from "../src/index.js";

const apiKey = process.env.AGENT37_API_KEY;

describe("Agent37 live read-only smoke", () => {
	it.skipIf(!apiKey)(
		"lists instances when AGENT37_API_KEY is explicitly supplied",
		async () => {
			if (!apiKey) throw new Error("AGENT37_API_KEY is unavailable");
			const client = createAgent37Client({
				apiKey,
				fetchImpl: globalThis.fetch,
			});
			const instances = await client.listInstances();
			expect(Array.isArray(instances)).toBe(true);
		},
		30_000,
	);
});
