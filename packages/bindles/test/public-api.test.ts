import { describe, expect, it } from "vitest";
import * as bindles from "../src/index.js";

describe("public API", () => {
	it("does not expose provider-specific or internal symbols", () => {
		const forbidden =
			/aws|azure|gcp|cloudflare|rds|fargate|cosmos|internal|cloud/i;
		expect(Object.keys(bindles).filter((name) => forbidden.test(name))).toEqual(
			[],
		);
	});

	it("does not export topology, runtime, or search symbols", () => {
		const exportNames = new Set(Object.keys(bindles));
		for (const forbidden of [
			"search",
			"camp",
			"yard",
			"junction",
			"workflow",
			"step",
		]) {
			expect(exportNames.has(forbidden)).toBe(false);
		}
	});
});
