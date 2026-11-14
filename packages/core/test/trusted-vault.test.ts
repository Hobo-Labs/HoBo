import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createTrustedVault } from "../src/index.js";

describe("trusted vault", () => {
	it("holds values in memory and never prints them", () => {
		const vault = createTrustedVault();
		vault.put("BWS_ACCESS_TOKEN", "s3cr3t-value");
		expect(vault.reveal("BWS_ACCESS_TOKEN")).toBe("s3cr3t-value");
		for (const shown of [
			JSON.stringify({ vault }),
			inspect(vault),
			String(vault),
			`${vault}`,
		])
			expect(shown).not.toContain("s3cr3t-value");
		expect(inspect(vault)).toContain("BWS_ACCESS_TOKEN");
	});

	it("expires and wipes", () => {
		let t = 0;
		const vault = createTrustedVault({ ttlMs: 10, now: () => t });
		vault.put("A", "x");
		t = 10;
		expect(vault.has("A")).toBe(false);
		vault.put("B", "y");
		vault.clear();
		expect(vault.names()).toEqual([]);
	});

	it("removes an untouched value when its lifetime expires", () => {
		vi.useFakeTimers();
		try {
			const vault = createTrustedVault({ ttlMs: 10 });
			vault.put("EXPIRES", "secret");
			vi.advanceTimersByTime(10);
			expect(JSON.stringify(vault)).not.toContain("EXPIRES");
			expect(vault.reveal("EXPIRES")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects invalid lifetimes", () => {
		for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => createTrustedVault({ ttlMs })).toThrow();
	});

	it("refuses an entry name that could smuggle a value", () => {
		expect(() => createTrustedVault().put("a b=c", "v")).toThrow(TypeError);
	});
});
