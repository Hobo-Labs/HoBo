/**
 * The parse boundary for the report this package produces.
 *
 * Every case asserts the *specific* refusal — the error class, its code, and
 * the field path — rather than "it threw". A parser has many ways to throw and
 * only one of them is the branch under test; `toThrow()` with no matcher goes
 * green when the value under test is undefined, when a helper is missing, and
 * when the refusal fires, which makes it evidence of nothing.
 */
import { describe, expect, it } from "vitest";

import {
	CHECK_OUTCOMES,
	canonicalRoundTripReportJson,
	hashRoundTripReport,
	parseRoundTripReport,
	ROUND_TRIP_REPORT_SCHEMA,
	RoundTripReportError,
} from "../src/index.js";

const CHECK = {
	shape: "ResourceIntent",
	owner: "@hobo/manifest-declaration",
	upstream: "packages/cloud/src/plan-types.ts",
	outcome: "single-declaration",
	detail: "plan-types.ts re-exports it; nothing is declared twice",
};

const REPORT = { schema: ROUND_TRIP_REPORT_SCHEMA, checks: [CHECK] };

function refusal(input: unknown): RoundTripReportError {
	try {
		parseRoundTripReport(input);
	} catch (error) {
		if (error instanceof RoundTripReportError) return error;
		throw error;
	}
	throw new Error("expected parseRoundTripReport to refuse, it returned");
}

describe("what the boundary admits", () => {
	it("accepts a minimal report and freezes it", () => {
		const parsed = parseRoundTripReport(REPORT);
		expect(parsed.schema).toBe(ROUND_TRIP_REPORT_SCHEMA);
		expect(parsed.checks.length).toBe(1);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.checks[0])).toBe(true);
	});

	it("accepts every outcome in the closed vocabulary", () => {
		for (const outcome of CHECK_OUTCOMES) {
			expect(
				parseRoundTripReport({
					...REPORT,
					checks: [{ ...CHECK, outcome }],
				}).checks[0]?.outcome,
			).toBe(outcome);
		}
	});

	it("canonicalizes to a stable digest across three passes", () => {
		const parsed = parseRoundTripReport(REPORT);
		const json = canonicalRoundTripReportJson(parsed);
		expect(
			canonicalRoundTripReportJson(parseRoundTripReport(JSON.parse(json))),
		).toBe(json);
		expect(hashRoundTripReport(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/u);
		// Key order in the input must not reach the digest.
		expect(
			hashRoundTripReport(
				parseRoundTripReport({ checks: [CHECK], schema: REPORT.schema }),
			),
		).toBe(hashRoundTripReport(parsed));
	});
});

describe("what the boundary refuses", () => {
	it("a schema that is not this one, naming both", () => {
		const error = refusal({ ...REPORT, schema: "hobo.manifest-round-trip/v2" });
		expect(error.code).toBe("INVALID_ROUND_TRIP_REPORT");
		expect(error.path).toBe("$.schema");
		expect(error.message).toContain('expected "hobo.manifest-round-trip/v1"');
		expect(error.message).toContain('got "hobo.manifest-round-trip/v2"');
	});

	it("an unknown field on the report, naming the field", () => {
		const error = refusal({ ...REPORT, checkedAt: 1 });
		expect(error.path).toBe("$.checkedAt");
		expect(error.message).toContain("is not a field of RoundTripReport");
	});

	it("an unknown field on a check, naming its index", () => {
		const error = refusal({
			...REPORT,
			checks: [CHECK, { ...CHECK, shape: "ResourcePlan", severity: "high" }],
		});
		expect(error.path).toBe("$.checks[1].severity");
		expect(error.message).toContain("is not a field of ManifestCheck");
	});

	it("an empty check list, because a report with no checks proves nothing", () => {
		const error = refusal({ ...REPORT, checks: [] });
		expect(error.path).toBe("$.checks");
		expect(error.message).toContain("a report with no checks proves nothing");
	});

	it("an outcome outside the closed set, listing the set", () => {
		const error = refusal({
			...REPORT,
			checks: [{ ...CHECK, outcome: "probably-fine" }],
		});
		expect(error.path).toBe("$.checks[0].outcome");
		expect(error.message).toContain(
			"expected one of single-declaration, parity, divergent",
		);
	});

	it("an empty detail, on every outcome and not only on divergent", () => {
		for (const outcome of CHECK_OUTCOMES) {
			const error = refusal({
				...REPORT,
				checks: [{ ...CHECK, outcome, detail: "" }],
			});
			expect(error.path).toBe("$.checks[0].detail");
			expect(error.message).toContain("must not be empty");
		}
	});

	it("two checks naming the same shape, because one of them is stale", () => {
		const error = refusal({ ...REPORT, checks: [CHECK, { ...CHECK }] });
		expect(error.path).toBe("$.checks[1].shape");
		expect(error.message).toContain('duplicates "ResourceIntent"');
	});

	it("a field present holding undefined, which is not the same as absent", () => {
		const error = refusal({
			...REPORT,
			checks: [{ ...CHECK, detail: undefined }],
		});
		expect(error.path).toBe("$.checks[0].detail");
		expect(error.message).toContain("expected a string, got undefined");
	});

	it("a checks value that is not an array, naming what it got", () => {
		const error = refusal({ ...REPORT, checks: { 0: CHECK } });
		expect(error.path).toBe("$.checks");
		expect(error.message).toContain("expected an array, got object");
	});

	it("a null report, rather than reading properties off it", () => {
		const error = refusal(null);
		expect(error.path).toBe("$");
		expect(error.message).toContain("expected an object, got null");
	});
});
