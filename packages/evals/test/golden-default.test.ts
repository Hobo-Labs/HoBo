import { describe, expect, it } from "vitest";

import {
	defineTrainableGoldenRubric,
	GOLDEN_DEFAULT_SUITE_ID,
	observeTrainableGolden,
	scoreRubric,
	scoreTrainableGoldenSuite,
} from "../src/index.js";

describe("trainable golden suite", () => {
	it("is exact-match over examples and traces, not occupancy state", () => {
		const rubric = defineTrainableGoldenRubric({
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
		expect(rubric.id).toBe(`${GOLDEN_DEFAULT_SUITE_ID}:shop.classify`);
		expect(rubric.criteria.map((row) => row.id)).toEqual([
			"spec.examples",
			"training.grounded",
			"example.0",
		]);
		expect(rubric.criteria.map((row) => row.id)).not.toContain("sidecar.live");
		expect(rubric.criteria.map((row) => row.id)).not.toContain(
			"bindle.inspectable",
		);
	});

	it("passes when blessed examples match actual trainable output", () => {
		const region = {
			methodRef: "shop.classify",
			grounded: true,
			cases: [
				{
					id: "example.0",
					expected: { label: "billing" },
					actual: { label: "billing" },
				},
			],
		};
		const report = scoreRubric(
			defineTrainableGoldenRubric(region),
			observeTrainableGolden(region),
		);
		expect(report.ok).toBe(true);
	});

	it("fails when the trainable output drifts from the blessed example", () => {
		const region = {
			methodRef: "shop.classify",
			grounded: true,
			cases: [
				{
					id: "example.0",
					expected: { label: "billing" },
					actual: { label: "shipping" },
				},
			],
		};
		const report = scoreRubric(
			defineTrainableGoldenRubric(region),
			observeTrainableGolden(region),
		);
		expect(report.ok).toBe(false);
		expect(report.failures.map((row) => row.criterionId)).toContain(
			"example.0",
		);
	});

	it("fails a region that cannot be trained — no examples and no grounding", () => {
		const suite = scoreTrainableGoldenSuite([
			{ methodRef: "shop.classify", grounded: false, cases: [] },
		]);
		expect(suite.ok).toBe(false);
		expect(suite.reports[0]?.failures.map((row) => row.criterionId)).toEqual(
			expect.arrayContaining(["spec.examples", "training.grounded"]),
		);
	});

	it("is vacuously ok when there is no trainable code yet", () => {
		expect(scoreTrainableGoldenSuite([]).ok).toBe(true);
		expect(scoreTrainableGoldenSuite([]).reports).toEqual([]);
	});
});
