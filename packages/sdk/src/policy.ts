import {
	definePolicyRule,
	EFFECT_RANK,
	type PolicyDecisionRequest,
	type PolicyEffect,
	type PolicyPack,
	type PolicyRule,
} from "@hobo/contracts";

import {
	deepFreeze,
	requireNonEmptyString,
	requireRecord,
	SdkDeclarationError,
} from "./errors.js";
import { POLICY_PACK_SCHEMA } from "./schema.js";

// This module WRAPS @hobo/contracts' policy-pack shapes (which in turn compose
// @hobo/policy's Policy IR) — it never reimplements evaluation. `rule()`
// compiles a declarative when-clause into a `definePolicyRule` predicate;
// `policyPack()` assembles a PolicyPack that `evaluatePolicyPack` accepts
// unchanged, so every SDK-authored pack records `policy.Decided` facts through
// the existing engine.

export type WhenClauseValue = string | number | boolean;

export interface SdkRuleSpec {
	phase: string;
	when: Record<string, WhenClauseValue>;
	effect: PolicyEffect;
	/** `mutate` payload — the artifact the rule adds (walkthrough: "auth-middleware"). */
	add?: string;
	/** Obligation id attached to the decision (walkthrough: "shadow-eval"). */
	obligation?: string;
	reason?: string;
}

export interface SdkPolicyRule extends PolicyRule {
	readonly phase: string;
	readonly effect: PolicyEffect;
	readonly whenClause: Readonly<Record<string, WhenClauseValue>>;
}

export interface SdkPolicyPackOptions {
	mandatory?: boolean;
	version?: string;
}

export interface SdkPolicyPack extends PolicyPack {
	readonly schema: string;
	/** A mandatory pack is a deny-ceiling lower scopes may only tighten (ADR-0074). */
	readonly mandatory: boolean;
	readonly rules: SdkPolicyRule[];
}

function matchesClause(
	request: PolicyDecisionRequest,
	key: string,
	expected: WhenClauseValue,
): boolean {
	const actual =
		key === "action"
			? request.action
			: key === "phase"
				? request.phase
				: request.context?.[key];
	if (typeof expected === "string" && expected.startsWith("!")) {
		return actual !== expected.slice(1);
	}
	return actual === expected;
}

export function rule(id: string, spec: SdkRuleSpec): SdkPolicyRule {
	requireNonEmptyString("rule", "id", id);
	const record = requireRecord("rule", "spec", spec);
	const phase = requireNonEmptyString("rule", "phase", record.phase);
	const effect = requireNonEmptyString("rule", "effect", record.effect);
	if (!EFFECT_RANK.has(effect)) {
		throw new SdkDeclarationError(
			"rule",
			"effect",
			`unknown effect "${effect}" — expected one of ${[...EFFECT_RANK.keys()].join(", ")}`,
		);
	}
	const when = requireRecord("rule", "when", record.when);
	for (const [key, value] of Object.entries(when)) {
		if (
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			throw new SdkDeclarationError(
				"rule",
				`when.${key}`,
				"must be a string, number, or boolean",
			);
		}
	}

	const whenClause = deepFreeze({ ...when } as Record<string, WhenClauseValue>);
	const obligations = [
		...(spec.obligation !== undefined
			? [
					{
						kind: "obligation",
						id: requireNonEmptyString("rule", "obligation", spec.obligation),
					},
				]
			: []),
		...(spec.add !== undefined
			? [
					{
						kind: "mutation",
						add: requireNonEmptyString("rule", "add", spec.add),
					},
				]
			: []),
	];
	const reason =
		spec.reason ?? `rule ${id} matched in phase ${phase}: ${effect}`;

	const compiled = definePolicyRule({
		id,
		when: (request) =>
			request.phase === phase &&
			Object.entries(whenClause).every(([key, expected]) =>
				matchesClause(request, key, expected),
			),
		decide: () => ({
			effect: effect as PolicyEffect,
			reason,
			...(obligations.length > 0 ? { obligations } : {}),
		}),
	});

	return deepFreeze({
		...compiled,
		phase,
		effect: effect as PolicyEffect,
		whenClause,
	});
}

export function policyPack(
	id: string,
	options: SdkPolicyPackOptions,
	rules: SdkPolicyRule[],
): SdkPolicyPack {
	requireNonEmptyString("policyPack", "id", id);
	requireRecord("policyPack", "options", options);
	if (!Array.isArray(rules)) {
		throw new SdkDeclarationError("policyPack", "rules", "must be an array");
	}
	const seen = new Set<string>();
	for (const candidate of rules) {
		const ruleId = requireNonEmptyString(
			"policyPack",
			"rules[].id",
			candidate?.id,
		);
		if (
			typeof candidate.when !== "function" ||
			typeof candidate.decide !== "function"
		) {
			throw new SdkDeclarationError(
				"policyPack",
				`rules[${ruleId}]`,
				"must be a compiled rule — author it with rule()",
			);
		}
		if (seen.has(ruleId)) {
			throw new SdkDeclarationError(
				"policyPack",
				`rules[${ruleId}]`,
				"duplicate rule id",
			);
		}
		seen.add(ruleId);
	}

	return deepFreeze({
		schema: POLICY_PACK_SCHEMA,
		id,
		version: options.version ?? "1.0.0",
		mandatory: options.mandatory === true,
		rules: [...rules],
	});
}
