import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
	mcpWaitCeilingMs,
	RELAY_FUNCTION_MAX_DURATION_SECONDS,
} from "../src/function-limits.js";

const deployment = z
	.object({
		functions: z.record(
			z.string(),
			z.object({ maxDuration: z.number().int().positive().optional() }),
		),
	})
	.parse(
		JSON.parse(
			readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
		),
	);

it("derives the MCP wait ceiling from the duration vercel.json gives the relay function", () => {
	// The platform is told this limit, and the code assumes the same one.
	expect(deployment.functions["api/relay.ts"]?.maxDuration).toBe(
		RELAY_FUNCTION_MAX_DURATION_SECONDS,
	);
	const ceiling = mcpWaitCeilingMs(RELAY_FUNCTION_MAX_DURATION_SECONDS);
	expect(ceiling).toBe(50_000);
	// A wait at the ceiling ends with half a minute of the function's time left.
	expect(ceiling + 30_000).toBeLessThanOrEqual(
		RELAY_FUNCTION_MAX_DURATION_SECONDS * 1000,
	);
});

it("shortens the wait for a shorter function, and refuses one with no time to wait", () => {
	for (const limit of [31, 45, 60, 79, 80, 300, 800]) {
		const ceiling = mcpWaitCeilingMs(limit);
		expect(ceiling).toBeGreaterThan(0);
		expect(ceiling + 30_000).toBeLessThanOrEqual(limit * 1000);
		// Never longer than an MCP client waits for an answer by default.
		expect(ceiling).toBeLessThanOrEqual(50_000);
	}
	expect(mcpWaitCeilingMs(60)).toBe(30_000);
	expect(mcpWaitCeilingMs(45)).toBe(15_000);
	for (const limit of [0, 10, 30, 60.5, Number.NaN])
		expect(() => mcpWaitCeilingMs(limit)).toThrow(/no time to wait/);
});
