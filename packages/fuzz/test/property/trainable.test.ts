import { describe, expect, it } from "vitest";

import {
	type FuzzValue,
	fuzzTrainable,
	silverEvidenceFromCorpus,
} from "../../src/index.js";

describe("trainable silver fuzz", () => {
	it("holds gold seeds and fail-closed oracles on a pure labeler", () => {
		const fn = (input: FuzzValue) => {
			const text =
				input && Object(input) === input && "text" in input
					? String(
							// SAFETY: the object branch establishes a property-bearing input.
							(input as { text?: unknown }).text ?? "",
						)
					: "";
			return { label: text.includes("invoice") ? "billing" : "other" };
		};
		const report = fuzzTrainable(
			fn,
			[
				{
					input: { text: "invoice overdue" },
					output: { label: "billing" },
				},
			],
			{ methodRef: "shop.classify" },
		);
		expect(report.ok).toBe(true);
		expect(report.seedHolds).toBe(true);
		expect(report.deterministic).toBe(true);
		expect(report.noPollution).toBe(true);
		expect(report.failClosed).toBe(true);
		expect(report.bounded).toBe(true);
	});

	it("fails when the trainable drifts from a blessed gold seed", () => {
		const report = fuzzTrainable(
			() => ({ label: "shipping" }),
			[{ input: { text: "invoice overdue" }, output: { label: "billing" } }],
		);
		expect(report.seedHolds).toBe(false);
		expect(report.ok).toBe(false);
	});

	it("fails when the trainable emits prototype pollution", () => {
		const report = fuzzTrainable(
			() => ({ constructor: { admin: true } }),
			[{ input: { text: "x" } }],
		);
		expect(report.noPollution).toBe(false);
		expect(report.ok).toBe(false);
	});

	it("corpus evidence stays fail-closed without a live function", () => {
		const evidence = silverEvidenceFromCorpus([
			{ input: { text: "invoice overdue" }, output: { label: "billing" } },
		]);
		expect(evidence.noPollution).toBe(true);
		expect(evidence.seedHolds).toBe(false);
	});
});
