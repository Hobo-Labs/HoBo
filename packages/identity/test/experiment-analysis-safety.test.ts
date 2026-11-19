import { describe, expect, it } from "vitest";
import {
	analyzeExperimentFromEngine,
	createBuiltinExperimentAnalysis,
	FeatureFlagStore,
	OpenExperimentEngine,
} from "../src/index.js";

describe("experiment analysis evidence", () => {
	it("does not infer a release decision from a weighted allocation without exposures or outcomes", () => {
		const engine = new OpenExperimentEngine({ store: new FeatureFlagStore() });
		engine.define({
			name: "weighted",
			flag: "checkout",
			variants: ["control", "treatment"],
			allocation: { weights: { control: 10, treatment: 90 } },
		});
		for (let index = 0; index < 200; index += 1)
			engine.assign("weighted", { targetingKey: `subject-${index}` });
		const result = analyzeExperimentFromEngine(engine, "weighted");
		expect(result?.totalAssigned).toBe(200);
		expect(result?.totalExposed).toBe(0);
		expect(result?.verdict).toBe("inconclusive");
		expect(result?.winningVariant).toBeUndefined();
	});

	it("allows a supplied outcome-aware adapter to return a release verdict", () => {
		const engine = new OpenExperimentEngine({ store: new FeatureFlagStore() });
		engine.define({
			name: "checkout",
			flag: "checkout",
			variants: ["control", "treatment"],
		});
		const observedOutcome = { eligible: 100, improvement: 0.15 };
		const result = analyzeExperimentFromEngine(engine, "checkout", {
			analyze(definition, assignments, exposedCount) {
				const baseline = createBuiltinExperimentAnalysis().analyze(
					definition,
					assignments,
					exposedCount,
				);
				return observedOutcome.eligible >= 100 &&
					observedOutcome.improvement > 0.1
					? { ...baseline, verdict: "ship", winningVariant: "treatment" }
					: baseline;
			},
		});
		expect(result?.verdict).toBe("ship");
		expect(result?.winningVariant).toBe("treatment");
	});

	it("counts reserved object-property names as ordinary variants", () => {
		const result = createBuiltinExperimentAnalysis().analyze(
			{ name: "reserved", flag: "flag", variants: ["__proto__", "treatment"] },
			[
				{
					experiment: "reserved",
					flag: "flag",
					variant: "__proto__",
					subjectKey: "subject",
					assignedAt: "time",
				},
			],
			0,
		);
		expect(Object.hasOwn(result.variantCounts, "__proto__")).toBe(true);
		expect(Object.entries(result.variantCounts)).toContainEqual([
			"__proto__",
			1,
		]);
		expect(result.totalAssigned).toBe(1);
		expect(result.verdict).toBe("inconclusive");
	});
});
