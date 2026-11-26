import { describe, expect, it } from "vitest";

import {
	defineTrainableSilverRubric,
	observeTrainableSilver,
	SILVER_DEFAULT_SUITE_ID,
	scoreRubric,
	scoreTrainableGoldSilverSuites,
	scoreTrainableSilverSuite,
	silverEvidenceFromRegion,
} from "../src/index.js";

describe("trainable silver suite", () => {
	it("scores property oracles, not occupancy state", () => {
		const rubric = defineTrainableSilverRubric({
			methodRef: "shop.classify",
			grounded: true,
			hasExamples: true,
			deterministic: true,
			failClosed: true,
			noPollution: true,
			seedHolds: true,
			bounded: true,
		});
		expect(rubric.id).toBe(`${SILVER_DEFAULT_SUITE_ID}:shop.classify`);
		expect(rubric.criteria.map((row) => row.id)).toEqual([
			"spec.examples",
			"training.grounded",
			"fuzz.seed-holds",
			"fuzz.deterministic",
			"fuzz.no-pollution",
			"fuzz.fail-closed",
			"fuzz.bounded",
		]);
	});

	it("passes when gold seeds hold and fuzz oracles are clean", () => {
		const evidence = silverEvidenceFromRegion({
			methodRef: "shop.classify",
			grounded: true,
			cases: [
				{
					id: "example.0",
					expected: { label: "billing" },
					actual: { label: "billing" },
				},
			],
		});
		const report = scoreRubric(
			defineTrainableSilverRubric(evidence),
			observeTrainableSilver(evidence),
		);
		expect(report.ok).toBe(true);
	});

	it("fails when a blessed seed drifts", () => {
		const evidence = silverEvidenceFromRegion({
			methodRef: "shop.classify",
			grounded: true,
			cases: [
				{
					id: "example.0",
					expected: { label: "billing" },
					actual: { label: "shipping" },
				},
			],
		});
		expect(evidence.seedHolds).toBe(false);
		const suite = scoreTrainableSilverSuite([evidence]);
		expect(suite.ok).toBe(false);
	});

	it("fails when gold seeds exist but nothing was observed", () => {
		const evidence = silverEvidenceFromRegion({
			methodRef: "shop.classify",
			grounded: true,
			cases: [{ id: "example.0", expected: { label: "billing" } }],
		});
		expect(evidence.seedHolds).toBe(false);
		expect(scoreTrainableSilverSuite([evidence]).ok).toBe(false);
	});

	it("fails when only some gold seeds were observed", () => {
		const evidence = silverEvidenceFromRegion({
			methodRef: "shop.classify",
			grounded: true,
			cases: [
				{
					id: "example.0",
					expected: { label: "billing" },
					actual: { label: "billing" },
				},
				{ id: "example.1", expected: { label: "other" } },
			],
		});
		expect(evidence.seedHolds).toBe(false);
	});

	it("does not crash when a posted actual is circular or bigint", () => {
		type CircularRecord = { label: string; self?: CircularRecord };
		const circ: CircularRecord = { label: "billing" };
		circ.self = circ;
		expect(() =>
			silverEvidenceFromRegion({
				methodRef: "shop.classify",
				grounded: true,
				cases: [
					{ id: "example.0", expected: { label: "billing" }, actual: circ },
				],
			}),
		).not.toThrow();
		const circular = silverEvidenceFromRegion({
			methodRef: "shop.classify",
			grounded: true,
			cases: [
				{ id: "example.0", expected: { label: "billing" }, actual: circ },
			],
		});
		expect(circular.seedHolds).toBe(false);
		const big = silverEvidenceFromRegion({
			methodRef: "shop.classify",
			grounded: true,
			cases: [{ id: "example.0", expected: 1n, actual: 1n }],
		});
		expect(big.seedHolds).toBe(true);
	});

	it("runs gold and silver together", () => {
		const scored = scoreTrainableGoldSilverSuites({
			regions: [
				{
					methodRef: "shop.classify",
					grounded: true,
					cases: [
						{
							id: "example.0",
							expected: { label: "billing" },
							actual: { label: "billing" },
						},
					],
				},
			],
		});
		expect(scored.ok).toBe(true);
		expect(scored.gold.ok).toBe(true);
		expect(scored.silver.ok).toBe(true);
	});
});
