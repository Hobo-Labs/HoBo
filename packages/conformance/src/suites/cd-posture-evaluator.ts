// PostureEvaluator conformance (plan 0024 D25, I8, I22). The Station-side
// evaluator is pure: the same rules and observation give the same findings in
// any order, unknown counts against compliance, and only the fixed operator
// set exists (no expression language).

import { isJsonArray, isJsonObject } from "../json.js";
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	canonicalText,
	check,
	checkSecretFree,
	runCdAssertions,
} from "./cd-kit.js";

export const POSTURE_EVALUATOR_SUITE = "hobo.cd.posture-evaluator/v1";

// public-contract: assertion names of the PostureEvaluator suite.
export const POSTURE_EVALUATOR_ASSERTIONS = Object.freeze([
	"permutationDeterminism",
	"compliantWhenAllHold",
	"violationIsNoncompliant",
	"unknownCountsAgainst",
	"unmatchedRuleIsNotApplicable",
	"everyOperatorDecides",
	"observedIsBoundedAndSecretFree",
	"inputsAreNotMutated",
] as const);
export type PostureEvaluatorAssertion =
	(typeof POSTURE_EVALUATOR_ASSERTIONS)[number];

// public-contract: the fixed posture operator set (D25).
export const POSTURE_OPERATOR_SET = Object.freeze([
	"eq",
	"neq",
	"in",
	"not-in",
	"exists",
	"absent",
	"lt",
	"lte",
	"gt",
	"gte",
	"semver-gte",
] as const);
export type PostureOperatorLike = (typeof POSTURE_OPERATOR_SET)[number];

export type PostureClauseLike =
	| Readonly<{ field: string; op: "exists" | "absent" }>
	| Readonly<{ field: string; op: "in" | "not-in"; values: readonly string[] }>
	| Readonly<{
			field: string;
			op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "semver-gte";
			value: string;
	  }>;

/** Structural mirror of @hobo/policy/posture PostureRule. */
export type PostureRuleLike = Readonly<{
	id: string;
	pack: string;
	phase: "observe";
	effect: "warn" | "mutate";
	kinds: readonly string[];
	classifications: readonly string[];
	require: readonly PostureClauseLike[];
	forbid: readonly PostureClauseLike[];
	severity: "info" | "low" | "medium" | "high" | "critical";
	controls: readonly string[];
	fix: readonly Readonly<{ field: string; value: string }>[];
}>;

export type PostureResourceLike = Readonly<{
	resource: string;
	kind: string;
	classification: string;
	attributes: Readonly<Record<string, string>>;
}>;

export type PostureStateLike =
	| "compliant"
	| "noncompliant"
	| "unknown"
	| "not-applicable";

export type PostureEvaluationLike = Readonly<{
	state: PostureStateLike;
	noncompliantRatio: number;
	findings: readonly Readonly<{
		rule: string;
		resource: string;
		state: PostureStateLike;
		observed: string;
	}>[];
}>;

export interface PostureEvaluatorHarness {
	readonly subject: string;
	evaluate(
		rules: readonly PostureRuleLike[],
		observation: Readonly<{ resources: readonly PostureResourceLike[] }>,
	): PostureEvaluationLike;
}

function rule(
	id: string,
	require: readonly PostureClauseLike[],
	forbid: readonly PostureClauseLike[] = [],
	kinds = ["bucket"],
): PostureRuleLike {
	return {
		id,
		pack: "conformance",
		phase: "observe",
		effect: "warn",
		kinds,
		classifications: [],
		require,
		forbid,
		severity: "high",
		controls: ["SC-28"],
		fix: [],
	};
}

function resource(
	name: string,
	attributes: Record<string, string>,
	kind = "bucket",
): PostureResourceLike {
	return { resource: name, kind, classification: "internal", attributes };
}

function deepFreeze<T>(value: T): T {
	if (isJsonArray(value)) for (const entry of value) deepFreeze(entry);
	else if (isJsonObject(value))
		for (const entry of Object.values(value)) deepFreeze(entry);
	return Object.freeze(value);
}

function canonicalFindings(evaluation: PostureEvaluationLike): string {
	const findings = [...evaluation.findings].sort((a, b) =>
		`${a.rule}\u0000${a.resource}`.localeCompare(
			`${b.rule}\u0000${b.resource}`,
		),
	);
	return canonicalText({
		state: evaluation.state,
		ratio: evaluation.noncompliantRatio,
		findings,
	});
}

/** One rule per operator, with the outcome its single resource must produce. */
export function operatorCases(): readonly Readonly<{
	op: PostureOperatorLike;
	rule: PostureRuleLike;
	holds: boolean;
}>[] {
	const cases: Readonly<{
		op: PostureOperatorLike;
		clause: PostureClauseLike;
		holds: boolean;
	}>[] = [
		{
			op: "eq",
			clause: { field: "encryption", op: "eq", value: "aes256" },
			holds: true,
		},
		{
			op: "neq",
			clause: { field: "encryption", op: "neq", value: "aes256" },
			holds: false,
		},
		{
			op: "in",
			clause: { field: "tier", op: "in", values: ["gold", "silver"] },
			holds: true,
		},
		{
			op: "not-in",
			clause: { field: "tier", op: "not-in", values: ["gold"] },
			holds: false,
		},
		{
			op: "exists",
			clause: { field: "encryption", op: "exists" },
			holds: true,
		},
		{ op: "absent", clause: { field: "public", op: "absent" }, holds: true },
		{
			op: "lt",
			clause: { field: "replicas", op: "lt", value: "3" },
			holds: false,
		},
		{
			op: "lte",
			clause: { field: "replicas", op: "lte", value: "3" },
			holds: true,
		},
		{
			op: "gt",
			clause: { field: "replicas", op: "gt", value: "2" },
			holds: true,
		},
		{
			op: "gte",
			clause: { field: "replicas", op: "gte", value: "4" },
			holds: false,
		},
		{
			op: "semver-gte",
			clause: { field: "version", op: "semver-gte", value: "1.10.0" },
			holds: false,
		},
	];
	return cases.map((c) => ({
		op: c.op,
		rule: rule(`op-${c.op}`, [c.clause]),
		holds: c.holds,
	}));
}

export const OPERATOR_RESOURCE: PostureResourceLike = resource("bucket-ops", {
	encryption: "aes256",
	tier: "gold",
	replicas: "3",
	version: "1.4.2",
});

export async function runPostureEvaluatorConformance(
	harness: PostureEvaluatorHarness,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<PostureEvaluatorAssertion>> {
	const encrypted = rule("encrypted", [
		{ field: "encryption", op: "in", values: ["aes256", "kms"] },
	]);
	const notPublic = rule(
		"not-public",
		[],
		[{ field: "public", op: "eq", value: "true" }],
	);
	const rules = [encrypted, notPublic];
	const good = [
		resource("bucket-a", { encryption: "aes256", public: "false" }),
		resource("bucket-b", { encryption: "kms", public: "false" }),
	];
	return runCdAssertions<PostureEvaluatorAssertion>(
		POSTURE_EVALUATOR_SUITE,
		harness.subject,
		{
			permutationDeterminism: async () => {
				const mixed = [
					...good,
					resource("bucket-c", { encryption: "none", public: "true" }),
				];
				const reference = canonicalFindings(
					harness.evaluate(rules, { resources: mixed }),
				);
				const variants = [
					{ r: [...rules].reverse(), o: mixed },
					{ r: rules, o: [...mixed].reverse() },
					{
						r: [...rules].reverse(),
						o: [mixed[2], mixed[0], mixed[1]].filter((x) => x !== undefined),
					},
				];
				for (const variant of variants) {
					check(
						canonicalFindings(
							harness.evaluate(variant.r, { resources: variant.o }),
						) === reference,
						"input order changed the findings",
						"evaluation is independent of rule and resource order (I8)",
					);
				}
			},
			compliantWhenAllHold: async () => {
				const evaluation = harness.evaluate(rules, { resources: good });
				check(
					evaluation.state === "compliant",
					`state ${evaluation.state} for a compliant observation`,
					"report compliant when every applicable clause holds",
				);
				check(
					evaluation.noncompliantRatio === 0,
					`ratio ${evaluation.noncompliantRatio}`,
					"ratio is 0 when compliant",
				);
			},
			violationIsNoncompliant: async () => {
				const evaluation = harness.evaluate(rules, {
					resources: [
						...good,
						resource("bucket-c", { encryption: "none", public: "true" }),
					],
				});
				check(
					evaluation.state === "noncompliant",
					`state ${evaluation.state} with a violating resource`,
					"a failed require or forbid is noncompliant",
				);
				check(
					evaluation.noncompliantRatio > 0,
					"ratio is 0 with a violation",
					"count violations in the ratio",
				);
				check(
					evaluation.findings.some(
						(f) => f.resource === "bucket-c" && f.state === "noncompliant",
					),
					"no noncompliant finding names bucket-c",
					"a finding names its resource",
				);
			},
			unknownCountsAgainst: async () => {
				const evaluation = harness.evaluate([encrypted], {
					resources: [resource("bucket-x", {})],
				});
				check(
					evaluation.state !== "compliant",
					"a missing attribute evaluated compliant",
					"an unreported attribute is unknown, never compliant (fail closed, I5)",
				);
				check(
					evaluation.noncompliantRatio > 0,
					"unknown did not count against the ratio",
					"unknown counts against compliance",
				);
			},
			unmatchedRuleIsNotApplicable: async () => {
				const evaluation = harness.evaluate(
					[
						rule(
							"db-only",
							[{ field: "tls", op: "eq", value: "on" }],
							[],
							["database"],
						),
					],
					{ resources: good },
				);
				check(
					evaluation.findings.every((f) => f.state === "not-applicable"),
					"a rule matching no resource produced an applicable finding",
					"a rule no resource matches is not-applicable",
				);
				check(
					evaluation.noncompliantRatio === 0,
					"not-applicable counted against the ratio",
					"only applicable findings count",
				);
			},
			everyOperatorDecides: async () => {
				for (const c of operatorCases()) {
					const evaluation = harness.evaluate([c.rule], {
						resources: [OPERATOR_RESOURCE],
					});
					const want = c.holds ? "compliant" : "noncompliant";
					check(
						evaluation.state === want,
						`operator ${c.op} gave ${evaluation.state}, want ${want}`,
						`implement ${c.op} exactly as D25 defines it`,
					);
				}
			},
			observedIsBoundedAndSecretFree: async () => {
				const long = "x".repeat(4096);
				const evaluation = harness.evaluate([encrypted], {
					resources: [resource("bucket-long", { encryption: long })],
				});
				for (const finding of evaluation.findings) {
					check(
						finding.observed.length <= 256,
						`observed summary is ${finding.observed.length} characters`,
						"bound the observed summary to 256 characters",
					);
				}
				checkSecretFree(
					harness.evaluate(rules, { resources: good }),
					"the evaluation",
				);
			},
			inputsAreNotMutated: async () => {
				const frozenRules = deepFreeze(structuredClone(rules));
				const frozenObservation = deepFreeze({
					resources: structuredClone(good),
				});
				const before = canonicalText({ frozenRules, frozenObservation });
				const a = canonicalFindings(
					harness.evaluate(frozenRules, frozenObservation),
				);
				const b = canonicalFindings(
					harness.evaluate(rules, { resources: good }),
				);
				check(
					canonicalText({ frozenRules, frozenObservation }) === before,
					"inputs changed",
					"the evaluator is pure",
				);
				check(
					a === b,
					"frozen inputs changed the result",
					"the evaluator is pure",
				);
			},
		},
		options,
	);
}
