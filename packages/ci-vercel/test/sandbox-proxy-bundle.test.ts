import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sandbox proxy bundle", () => {
	it("retains third-party notices", () => {
		const generated = readFileSync(
			new URL(
				"../src/_generated-assets/sandbox-proxy-bundle.ts",
				import.meta.url,
			),
			"utf8",
		);
		for (const dependency of [
			"@vercel/sandbox@",
			"jose@",
			"lru-cache@",
			"zod@",
		]) {
			expect(generated).toContain(dependency);
		}
		expect(generated).toContain("Permission is hereby granted");
	});
});
