import { describe, expect, it } from "vitest";
import { agentRunDuration, slow } from "./support/slow.js";

describe("test timeouts for slow runners", () => {
	it("keeps the default minimum and accepts only a larger finite wall-clock limit", () => {
		expect(slow(60_000, {})).toBe(60_000);
		expect(slow(60_000, { HOBO_TEST_TIMEOUT: "300000" })).toBe(300_000);
		for (const value of ["1000", "invalid", "Infinity", "-1"])
			expect(slow(60_000, { HOBO_TEST_TIMEOUT: value })).toBe(60_000);
	});

	it("allows extra time for the child but never reduces the original observation period", () => {
		expect(agentRunDuration({})).toBe(8_000);
		expect(agentRunDuration({ HOBO_TEST_AGENT_RUN_MS: "30000" })).toBe(30_000);
		for (const value of ["", "7999", "invalid", "Infinity", "120001"])
			expect(() => agentRunDuration({ HOBO_TEST_AGENT_RUN_MS: value })).toThrow(
				/HOBO_TEST_AGENT_RUN_MS/u,
			);
	});
});
