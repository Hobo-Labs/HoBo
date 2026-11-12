// @hobo/policy/posture (plan 0024 WP24, D25): the observe-phase posture rule
// profile, the pure evaluator, observe_fields, remediation resolution and the
// OSCAL assessment-results export.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonValue } from "../../src/json.js";
import { POLICY_IR_SCHEMA_VERSION } from "../../src/policy-ir.js";
import {
	compareSemver,
	effectiveRemediation,
	evaluateClause,
	evaluatePosture,
	observeFields,
	POSTURE_OPERATORS,
	POSTURE_PROFILE,
	type PostureComplianceInput,
	PosturePackError,
	parsePosturePack,
	resolvePostureBindings,
	toOscalAssessmentResults,
} from "../../src/posture/index.js";
import { createValidator } from "./json-schema.js";

const TLS_PACK = {
	schemaVersion: POLICY_IR_SCHEMA_VERSION,
	profile: POSTURE_PROFILE,
	pack: "tls-baseline",
	observeFields: ["tls.min_version", "tls.enabled", "public"],
	rules: [
		{
			id: "tls-min-version",
			phase: "observe",
			effect: "mutate",
			match: { kinds: ["http-route"], classifications: ["pii"] },
			require: [{ field: "tls.min_version", op: "semver-gte", value: "1.2" }],
			severity: "high",
			controls: ["SC-8", "SC-13"],
			fix: [{ field: "tls.min_version", value: "1.3" }],
		},
		{
			id: "no-public-pii",
			phase: "observe",
			effect: "warn",
			match: { kinds: ["bucket"], classifications: ["pii"] },
			forbid: [{ field: "public", op: "eq", value: true }],
			severity: "critical",
			controls: ["AC-3"],
		},
	],
};

describe("posture rule profile: parse, don't validate", () => {
	it("parses a policy-IR observe-phase rule pack into a typed pack", () => {
		const pack = parsePosturePack(TLS_PACK);
		expect(pack.pack).toBe("tls-baseline");
		expect(pack.rules.map((r) => r.id)).toEqual([
			"no-public-pii",
			"tls-min-version",
		]);
		const forbid = pack.rules[0]?.forbid[0];
		// Scalars are canonicalised to strings at the boundary.
		expect(forbid).toEqual({ field: "public", op: "eq", value: "true" });
		expect(Object.isFrozen(pack.rules)).toBe(true);
	});

	it.each([
		[
			"unknown operator",
			{ op: "matches", value: "x" },
			"posture-operator-unknown",
		],
		["missing value", { op: "eq" }, "posture-value-missing"],
		["in without values", { op: "in", values: [] }, "posture-values-missing"],
		["non-numeric lt", { op: "lt", value: "abc" }, "posture-value-not-numeric"],
		[
			"bad semver",
			{ op: "semver-gte", value: "one" },
			"posture-value-not-semver",
		],
		[
			"value on exists",
			{ op: "exists", value: "x" },
			"posture-value-unexpected",
		],
	])("refuses a clause with %s", (_name, clause, code) => {
		const pack = structuredClone(TLS_PACK);
		pack.rules[1].forbid = [{ field: "public", ...clause } as never];
		expect(() => parsePosturePack(pack)).toThrowError(
			expect.objectContaining({ code }),
		);
	});

	it("refuses a rule outside the observe phase, an undeclared field, an enforce pin and mutate without a fix", () => {
		const phase = structuredClone(TLS_PACK);
		phase.rules[0].phase = "apply";
		expect(() => parsePosturePack(phase)).toThrowError(
			expect.objectContaining({ code: "posture-phase-invalid" }),
		);
		const undeclared = structuredClone(TLS_PACK);
		undeclared.observeFields = ["tls.min_version"];
		expect(() => parsePosturePack(undeclared)).toThrowError(
			expect.objectContaining({ code: "posture-field-undeclared" }),
		);
		const pin = { ...structuredClone(TLS_PACK), remediation: "enforce" };
		expect(() => parsePosturePack(pin)).toThrowError(
			expect.objectContaining({ code: "posture-remediation-invalid" }),
		);
		const noFix = structuredClone(TLS_PACK);
		delete (noFix.rules[0] as { fix?: unknown }).fix;
		expect(() => parsePosturePack(noFix)).toThrowError(
			expect.objectContaining({ code: "posture-fix-missing" }),
		);
		const wrongProfile = { ...structuredClone(TLS_PACK), profile: "x" };
		expect(() => parsePosturePack(wrongProfile)).toThrowError(PosturePackError);
	});

	it("every refusal names a path and a remediation", () => {
		try {
			parsePosturePack({ ...TLS_PACK, rules: "nope" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(PosturePackError);
			const typed = error as PosturePackError;
			expect(typed.path).toBe("$.rules");
			expect(typed.remediation.length).toBeGreaterThan(0);
		}
	});
});

describe("evaluator golden vectors (every operator)", () => {
	type Vector = readonly [
		op: string,
		operand: Readonly<{ value?: string; values?: readonly string[] }>,
		observed: string | undefined,
		expected: boolean | undefined,
	];
	const VECTORS: readonly Vector[] = [
		["eq", { value: "on" }, "on", true],
		["eq", { value: "on" }, "off", false],
		["eq", { value: "on" }, undefined, undefined],
		["neq", { value: "on" }, "off", true],
		["neq", { value: "on" }, "on", false],
		["neq", { value: "on" }, undefined, undefined],
		["in", { values: ["a", "b"] }, "b", true],
		["in", { values: ["a", "b"] }, "c", false],
		["in", { values: ["a"] }, undefined, undefined],
		["not-in", { values: ["a", "b"] }, "c", true],
		["not-in", { values: ["a", "b"] }, "a", false],
		["not-in", { values: ["a"] }, undefined, undefined],
		["exists", {}, "", true],
		["exists", {}, undefined, false],
		["absent", {}, undefined, true],
		["absent", {}, "x", false],
		["lt", { value: "10" }, "9.5", true],
		["lt", { value: "10" }, "10", false],
		["lt", { value: "10" }, "ten", undefined],
		["lte", { value: "10" }, "10", true],
		["lte", { value: "10" }, "1e2", false],
		["gt", { value: "-1" }, "0", true],
		["gt", { value: "-1" }, "-1", false],
		["gte", { value: "2" }, "2", true],
		["gte", { value: "2" }, "1.99", false],
		["gte", { value: "2" }, undefined, undefined],
		["semver-gte", { value: "1.2" }, "1.3", true],
		["semver-gte", { value: "1.2" }, "v1.2.0", true],
		["semver-gte", { value: "1.2" }, "1.1.9", false],
		["semver-gte", { value: "1.2.0" }, "1.2.0-rc.1", false],
		["semver-gte", { value: "1.2.0-rc.2" }, "1.2.0-rc.10", true],
		["semver-gte", { value: "1.2" }, "TLSv1.2", undefined],
	];

	it("covers the whole fixed operator set", () => {
		expect(new Set(VECTORS.map((v) => v[0]))).toEqual(
			new Set(POSTURE_OPERATORS),
		);
	});

	it.each(VECTORS)("%s %j on %j is %s", (op, operand, observed, expected) => {
		const attributes = observed === undefined ? {} : { f: observed };
		expect(
			evaluateClause({ field: "f", op, ...operand } as never, attributes),
		).toBe(expected);
	});

	it("orders semver per precedence (prerelease below release, numeric identifiers numerically)", () => {
		expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
		expect(compareSemver("1.0.0-alpha.beta", "1.0.0-beta")).toBeLessThan(0);
		expect(compareSemver("1.0.0-beta.11", "1.0.0-rc.1")).toBeLessThan(0);
		expect(compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
		expect(compareSemver("2.0.0", "10.0.0")).toBeLessThan(0);
		expect(compareSemver("x", "1.0.0")).toBeUndefined();
	});
});

describe("evaluatePosture: pure, deterministic, per-rule per-resource", () => {
	const pack = parsePosturePack(TLS_PACK);
	const resources = [
		{
			resource: "api",
			kind: "http-route",
			classification: "pii",
			attributes: { "tls.min_version": "1.0" },
		},
		{
			resource: "web",
			kind: "http-route",
			classification: "pii",
			attributes: { "tls.min_version": "1.3" },
		},
		{
			resource: "docs",
			kind: "http-route",
			classification: "public",
			attributes: { "tls.min_version": "1.0" },
		},
		{
			resource: "uploads",
			kind: "bucket",
			classification: "pii",
			attributes: {},
		},
	];

	it("matches by kind and classification, asserts require/forbid, and summarises", () => {
		const result = evaluatePosture(pack.rules, { resources });
		expect(result.findings.map((f) => [f.rule, f.resource, f.state])).toEqual([
			["no-public-pii", "uploads", "unknown"],
			["tls-min-version", "api", "noncompliant"],
			["tls-min-version", "web", "compliant"],
		]);
		expect(result.state).toBe("noncompliant");
		// Unknown counts against compliance (fail closed): 2 of 3 applicable.
		expect(result.noncompliantRatio).toBeCloseTo(2 / 3);
		const api = result.findings[1];
		expect(api?.severity).toBe("high");
		expect(api?.controls).toEqual(["SC-13", "SC-8"]);
		expect(api?.observed).toBe("tls.min_version=1.0");
	});

	it("is independent of input order and never reads a clock", () => {
		const a = evaluatePosture(pack.rules, { resources });
		const b = evaluatePosture([...pack.rules].reverse(), {
			resources: [...resources].reverse(),
		});
		expect(b).toEqual(a);
	});

	it("records a not-applicable finding for a rule no resource matches", () => {
		const result = evaluatePosture(pack.rules, {
			resources: [resources[1] ?? resources[0]],
		});
		expect(result.findings.map((f) => [f.rule, f.state])).toEqual([
			["no-public-pii", "not-applicable"],
			["tls-min-version", "compliant"],
		]);
		expect(result.state).toBe("compliant");
		expect(result.noncompliantRatio).toBe(0);
	});

	it("is not-applicable with no rules", () => {
		expect(evaluatePosture([], { resources }).state).toBe("not-applicable");
	});

	it("caps the observed summary so a finding stays bounded", () => {
		const big = evaluatePosture(pack.rules, {
			resources: [
				{
					...resources[0],
					attributes: { "tls.min_version": "9".repeat(5000) },
				},
			],
		});
		expect(big.findings.at(-1)?.observed.length).toBeLessThanOrEqual(256);
	});
});

describe("observe_fields and remediation", () => {
	it("observeFields is the sorted union over packs", () => {
		const other = parsePosturePack({
			...TLS_PACK,
			pack: "other",
			observeFields: ["encryption.at_rest", "public"],
			rules: [],
		});
		expect(observeFields([parsePosturePack(TLS_PACK), other])).toEqual([
			"encryption.at_rest",
			"public",
			"tls.enabled",
			"tls.min_version",
		]);
	});

	it("inform-only cannot be escalated by a parent enforce", () => {
		const pack = parsePosturePack({ ...TLS_PACK, remediation: "inform-only" });
		const rule = pack.rules.find((r) => r.id === "tls-min-version");
		if (!rule) throw new Error("rule");
		expect(effectiveRemediation({ binding: "enforce", pack, rule })).toBe(
			"inform-only",
		);
		const ruleOnly = parsePosturePack(TLS_PACK);
		const pinned = {
			...ruleOnly.rules[1],
			remediation: "inform-only",
		} as (typeof ruleOnly.rules)[number];
		expect(
			effectiveRemediation({
				binding: "enforce",
				pack: ruleOnly,
				rule: pinned,
			}),
		).toBe("inform-only");
		expect(
			effectiveRemediation({
				binding: "inform-only",
				pack: ruleOnly,
				rule: ruleOnly.rules[1],
			}),
		).toBe("inform-only");
	});

	it("enforce applies only to mutate rules under an enforce binding", () => {
		const pack = parsePosturePack(TLS_PACK);
		const [warn, mutate] = pack.rules;
		if (!warn || !mutate) throw new Error("rules");
		expect(
			effectiveRemediation({ binding: "enforce", pack, rule: mutate }),
		).toBe("enforce");
		expect(effectiveRemediation({ binding: "enforce", pack, rule: warn })).toBe(
			"inform",
		);
		expect(
			effectiveRemediation({ binding: "inform", pack, rule: mutate }),
		).toBe("inform");
	});

	it("a pack bound twice resolves to the most conservative mode", () => {
		expect(
			resolvePostureBindings([
				{ pack: "a", remediation: "enforce" },
				{ pack: "a", remediation: "inform-only" },
				{ pack: "b", remediation: "enforce" },
				{ pack: "c", remediation: "enforce" },
				{ pack: "c", remediation: "inform" },
			]),
		).toEqual(
			new Map([
				["a", "inform-only"],
				["b", "enforce"],
				["c", "inform"],
			]),
		);
	});
});

describe("OSCAL assessment results", () => {
	const schema = JSON.parse(
		readFileSync(
			new URL(
				"./fixtures/oscal_assessment-results_schema-1.1.2.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const validate = createValidator(schema);
	const DIGEST = `sha256:${"a".repeat(64)}`;
	const records: PostureComplianceInput[] = [
		{
			campId: "prod-eu-1",
			railDigest: DIGEST,
			candidate: false,
			state: "noncompliant",
			observationPosition: "42",
			evaluatedAt: "2026-11-12T12:00:00.000Z",
			findings: [
				{
					rule: "tls-min-version",
					resource: "api",
					state: "noncompliant",
					severity: "high",
					controls: ["SC-8", "SC-13"],
					observed: "tls.min_version=1.0",
					ownershipConflict: true,
				},
				{
					rule: "no-public-pii",
					resource: "",
					state: "not-applicable",
					severity: "critical",
					controls: ["AC-3"],
					observed: "",
					ownershipConflict: false,
				},
			],
		},
		{
			campId: "prod-eu-2",
			railDigest: DIGEST,
			candidate: true,
			state: "compliant",
			observationPosition: "43",
			evaluatedAt: "2026-11-12T12:05:00.000Z",
			findings: [
				{
					rule: "tls-min-version",
					resource: "web",
					state: "compliant",
					severity: "high",
					controls: ["SC-8"],
					observed: "tls.min_version=1.3",
					ownershipConflict: false,
				},
			],
		},
	];

	it("validates against the pinned OSCAL 1.1.2 assessment-results schema", () => {
		const document = toOscalAssessmentResults(records);
		const json: JsonValue = JSON.parse(JSON.stringify(document));
		expect(validate(json)).toEqual([]);
	});

	it("rejects an invalid document (the validator is not vacuous)", () => {
		const document: JsonValue = JSON.parse(
			JSON.stringify(toOscalAssessmentResults(records)),
		);
		if (!isJsonObject(document)) throw new Error("document");
		const broken = {
			"assessment-results": { ...document["assessment-results"], uuid: "nope" },
		};
		expect(validate(broken).length).toBeGreaterThan(0);
	});

	it("is deterministic, order-independent and maps control status", () => {
		const a = toOscalAssessmentResults(records);
		const b = toOscalAssessmentResults([...records].reverse());
		expect(b).toEqual(a);
		const ar = a["assessment-results"];
		expect(ar.metadata["last-modified"]).toBe("2026-11-12T12:05:00.000Z");
		const first = ar.results[0];
		const sc8 = first?.findings.find((f) => f.target["target-id"] === "sc-8");
		expect(sc8?.target.status.state).toBe("not-satisfied");
		const ac3 = first?.findings.find((f) => f.target["target-id"] === "ac-3");
		expect(ac3?.target.status.state).toBe("satisfied");
		expect(first?.props).toContainEqual({
			name: "hobo-camp",
			value: "prod-eu-1",
		});
		expect(Object.isFrozen(ar)).toBe(true);
	});

	it("refuses an empty record set (OSCAL needs at least one result)", () => {
		expect(() => toOscalAssessmentResults([])).toThrowError(
			expect.objectContaining({ code: "posture-oscal-empty" }),
		);
	});
});
