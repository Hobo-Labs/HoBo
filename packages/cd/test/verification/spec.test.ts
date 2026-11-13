import { create, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Sensitivity,
	VerificationSpecRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_DEFAULTS } from "../../src/events.js";
import {
	parseVerificationSpec,
	parseVerificationSpecJson,
} from "../../src/verification/spec.js";
import {
	bodyObject,
	comparisonSpec,
	MINUTE,
	query,
	thresholdSpec,
} from "./fakes.js";

const codes = (outcome: ReturnType<typeof parseVerificationSpec>) =>
	outcome.ok ? [] : outcome.reasons.map((r) => r.code);

describe("parseVerificationSpec applies CD_DEFAULTS", () => {
	it("fills window, observations, deadline, sensitivity and min samples", () => {
		const spec = comparisonSpec({
			windowMs: 0n,
			requiredObservations: 0,
			progressDeadlineMs: 0n,
		});
		const comparison = spec.comparisons[0];
		if (comparison) {
			comparison.sensitivity = Sensitivity.UNSPECIFIED;
			comparison.minSamples = 0;
		}
		const parsed = parseVerificationSpec(spec);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.windowMs).toBe(
			BigInt(CD_DEFAULTS.verificationWindowMs),
		);
		expect(parsed.value.requiredObservations).toBe(
			CD_DEFAULTS.verificationRequiredObservations,
		);
		expect(parsed.value.progressDeadlineMs).toBe(
			BigInt(CD_DEFAULTS.verificationProgressDeadlineMs),
		);
		expect(parsed.value.comparisons[0]?.sensitivity).toBe(Sensitivity.MEDIUM);
		expect(parsed.value.comparisons[0]?.minSamples).toBe(
			CD_DEFAULTS.verificationRequiredObservations,
		);
	});

	it("does not mutate its input", () => {
		const spec = thresholdSpec({ windowMs: 0n });
		parseVerificationSpec(spec);
		expect(spec.windowMs).toBe(0n);
	});

	it("probe defaults: expect 200, every attempt must succeed, interval spreads required observations over the window", () => {
		const parsed = parseVerificationSpec(
			thresholdSpec({
				probes: [{ name: "health", urlRef: "https://api.example.com/healthz" }],
			}),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const probe = parsed.value.probes[0];
		expect(probe?.expectStatus).toBe(200);
		expect(probe?.minSuccessRatio).toBe(1);
		expect(probe?.intervalMs).toBe(BigInt((10 * MINUTE) / 3));
	});

	it("fail_on_no_data defaults to true in an authored document", () => {
		const json = toJson(
			VerificationSpecRecordSchema,
			thresholdSpec({ failOnNoData: false }),
		);
		const parsed = parseVerificationSpecJson(json);
		expect(parsed.ok && parsed.value.failOnNoData).toBe(true);
		const explicit = parseVerificationSpecJson({
			...bodyObject(json),
			failOnNoData: false,
		});
		expect(explicit.ok && explicit.value.failOnNoData).toBe(false);
	});
});

describe("parseVerificationSpec refuses specs that could pass on absent evidence", () => {
	it("a spec with no checks", () => {
		expect(
			codes(parseVerificationSpec(create(VerificationSpecRecordSchema, {}))),
		).toEqual(["verification-spec-empty"]);
	});

	it("a deadline shorter than the window", () => {
		expect(
			codes(
				parseVerificationSpec(
					thresholdSpec({ progressDeadlineMs: BigInt(MINUTE) }),
				),
			),
		).toEqual(["verification-deadline-before-window"]);
	});

	it("duplicate check names", () => {
		const spec = thresholdSpec();
		const first = spec.thresholds[0];
		if (first) spec.thresholds.push(first);
		expect(codes(parseVerificationSpec(spec))).toContain(
			"verification-duplicate-check",
		);
	});

	it("an error-budget ceiling with no burn_rate series", () => {
		expect(
			codes(parseVerificationSpec(thresholdSpec({ maxErrorBudgetBurn: 2 }))),
		).toEqual(["verification-error-budget-unbound"]);
	});

	it("a probe interval longer than the window (slo-as-code: window shorter than its sampling interval)", () => {
		const spec = thresholdSpec({
			probes: [
				{
					name: "health",
					urlRef: "https://api.example.com/",
					intervalMs: BigInt(11 * MINUTE),
				},
			],
		});
		expect(codes(parseVerificationSpec(spec))).toEqual([
			"verification-probe-interval-exceeds-window",
		]);
	});

	it("non-https endpoints, unspecified comparator/aggregation/direction, bad ratio — every problem is reported", () => {
		const spec = thresholdSpec({
			thresholds: [
				{
					query: query("x", { endpointRef: "http://plain.example.com" }),
					value: Number.NaN,
				},
			],
			comparisons: [{ query: query("y", { cohortLabel: "" }) }],
			probes: [
				{ name: "p", urlRef: "https://a.example.com", minSuccessRatio: 1.5 },
			],
		});
		const found = codes(parseVerificationSpec(spec));
		expect(
			found.filter((code) => code === "verification-spec-invalid").length,
		).toBe(7);
	});

	it("every refusal carries a remediation", () => {
		const outcome = parseVerificationSpec(
			create(VerificationSpecRecordSchema, {}),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		for (const reason of outcome.reasons)
			expect(reason.remediation).not.toBe("");
	});

	it("an authored document with an unknown field is refused, not dropped", () => {
		expect(
			codes(parseVerificationSpecJson({ windowMs: "60000", surprise: true })),
		).toEqual(["verification-spec-invalid"]);
	});
});
