import { describe, expect, it } from "vitest";
import { createAgent37Client } from "../src/index.js";

const apiKey = process.env.AGENT37_API_KEY;

describe("Agent37 live read-only smoke", () => {
	it("lists instances only when explicitly configured", async () => {
		if (apiKey === undefined || apiKey === "") {
			throw new Error("AGENT37_API_KEY is required for the live smoke test");
		}
		const client = createAgent37Client({ apiKey, fetchImpl: globalThis.fetch });
		const instances = await client.listInstances();
		expect(Array.isArray(instances)).toBe(true);
	}, 30_000);
});
