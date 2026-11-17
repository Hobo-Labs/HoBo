import { expect, it } from "vitest";
import { runNightlyCampaign } from "../src/campaign.js";

it("runs repeatable model, event and policy campaigns with the requested seed", () => {
	const first = runNightlyCampaign({ seed: 1742, runs: 60 });
	const replay = runNightlyCampaign({ seed: 1742, runs: 60 });
	expect(first).toEqual(replay);
	expect(first).toEqual({
		seed: 1742,
		modelTraces: 60,
		eventDocuments: 60,
		policyDocuments: 60,
		serializedInputs: 60,
	});
});

it.each([
	0,
	-1,
	100_001,
	1.5,
	Number.NaN,
])("rejects unsafe campaign sizes", (runs) => {
	expect(() => runNightlyCampaign({ seed: 1, runs })).toThrow("runs");
});

it.each([
	Number.NaN,
	Number.POSITIVE_INFINITY,
	2 ** 31,
	-(2 ** 31) - 1,
	0.5,
])("rejects invalid seeds", (seed) => {
	expect(() => runNightlyCampaign({ seed, runs: 1 })).toThrow("seed");
});

it.each([
	0, 1, -7, 2147483647,
])("keeps invariants for a longer seeded campaign", (seed) => {
	expect(runNightlyCampaign({ seed, runs: 500 }).modelTraces).toBe(500);
}, 120_000);
