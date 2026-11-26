/**
 * In-process policy document evaluator (Rego-inspired JSON rules).
 * Used when OPA HTTP/CLI is unavailable — still tenant-aware and auditable.
 *
 * Rule document shape (JSON):
 * {
 *   "default": "deny" | "allow",
 *   "rules": [
 *     {
 *       "effect": "allow" | "deny",
 *       "actions": ["junction.join", "*"],
 *       "when": {
 *         "sameTenant": true,
 *         "subjectTagsAny": ["role:admin"],
 *         "subjectTagsAll": ["role:junction"],
 *         "resourceKinds": ["junction", "dns-endpoint"],
 *         "resourceShared": true
 *       }
 *     }
 *   ]
 * }
 */

import {
	allowDecision,
	denyDecision,
	type PolicyDecision,
	type PolicyRequest,
} from "@hobo/core";
import { parseIsolationClass } from "../env-isolation/types.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

// Keep engine id local to avoid circular import with opa-engine.ts.
const REGO_LITE_ENGINE_ID = "hobo.policy.opa-rego/v1" as const;

export interface RegoLiteWhen {
	readonly sameTenant?: boolean;
	/** Require subject and resource share the same env: isolation class. */
	readonly sameEnv?: boolean;
	readonly subjectTagsAny?: readonly string[];
	readonly subjectTagsAll?: readonly string[];
	readonly resourceKinds?: readonly string[];
	readonly resourceShared?: boolean;
	readonly actions?: readonly string[];
}

function stringList(
	value: JsonValue | undefined,
): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is string => isJsonString(entry));
	return items.length > 0 ? items : undefined;
}

interface MutableRegoLiteWhen {
	sameTenant?: boolean;
	sameEnv?: boolean;
	subjectTagsAny?: readonly string[];
	subjectTagsAll?: readonly string[];
	resourceKinds?: readonly string[];
	resourceShared?: boolean;
	actions?: readonly string[];
}

function parseRegoLiteWhen(value: JsonObject): RegoLiteWhen {
	const when: MutableRegoLiteWhen = {};
	if (value.sameTenant === true || value.sameTenant === false)
		when.sameTenant = value.sameTenant;
	if (value.sameEnv === true || value.sameEnv === false)
		when.sameEnv = value.sameEnv;
	const subjectTagsAny = stringList(value.subjectTagsAny);
	if (subjectTagsAny) when.subjectTagsAny = subjectTagsAny;
	const subjectTagsAll = stringList(value.subjectTagsAll);
	if (subjectTagsAll) when.subjectTagsAll = subjectTagsAll;
	const resourceKinds = stringList(value.resourceKinds);
	if (resourceKinds) when.resourceKinds = resourceKinds;
	if (value.resourceShared === true || value.resourceShared === false)
		when.resourceShared = value.resourceShared;
	const actions = stringList(value.actions);
	if (actions) when.actions = actions;
	return when;
}

export interface RegoLiteRule {
	readonly effect: "allow" | "deny";
	readonly actions?: readonly string[];
	readonly when?: RegoLiteWhen;
	readonly reason?: string;
}

export interface RegoLiteDocument {
	readonly default?: "allow" | "deny";
	readonly rules: readonly RegoLiteRule[];
}

export function parseRegoLiteDocument(raw: JsonValue): RegoLiteDocument {
	if (raw === null || !isJsonObject(raw)) {
		throw new TypeError("rego-lite document must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = raw as JsonObject;
	if (!Array.isArray(obj.rules)) {
		throw new TypeError("rego-lite.rules must be an array");
	}
	const rules: RegoLiteRule[] = obj.rules.map((r, i) => {
		if (!r || !isJsonObject(r)) {
			throw new TypeError(`rego-lite.rules[${i}] must be an object`);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		const rule = r as JsonObject;
		if (rule.effect !== "allow" && rule.effect !== "deny") {
			throw new TypeError(`rego-lite.rules[${i}].effect must be allow|deny`);
		}
		return {
			effect: rule.effect,
			...(Array.isArray(rule.actions)
				? {
						actions: rule.actions.filter((a): a is string => isJsonString(a)),
					}
				: undefined),
			...(rule.when && isJsonObject(rule.when)
				? { when: parseRegoLiteWhen(rule.when) }
				: undefined),
			...(isJsonString(rule.reason) ? { reason: rule.reason } : undefined),
		};
	});
	return {
		rules,
		...(obj.default === "allow" || obj.default === "deny"
			? { default: obj.default }
			: undefined),
	};
}

export function evaluateRegoLite(
	doc: RegoLiteDocument,
	request: PolicyRequest,
	engineId: string = REGO_LITE_ENGINE_ID,
): PolicyDecision {
	for (const rule of doc.rules) {
		if (!actionMatches(rule.actions ?? rule.when?.actions, request.action)) {
			continue;
		}
		if (!whenMatches(rule.when, request)) {
			continue;
		}
		const reason = rule.reason ?? `rego-lite rule ${rule.effect}`;
		return rule.effect === "allow"
			? allowDecision(engineId, request, [reason])
			: denyDecision(engineId, request, [reason]);
	}
	const def = doc.default ?? "deny";
	return def === "allow"
		? allowDecision(engineId, request, ["rego-lite default allow"])
		: denyDecision(engineId, request, ["rego-lite default deny"]);
}

function actionMatches(
	actions: readonly string[] | undefined,
	action: string,
): boolean {
	if (!actions || actions.length === 0) return true;
	return actions.some((a) => a === "*" || a === action);
}

function whenMatches(
	when: RegoLiteWhen | undefined,
	request: PolicyRequest,
): boolean {
	if (!when) return true;
	const sameTenant = request.subject.tenantId === request.resource.tenantId;
	if (when.sameTenant === true && !sameTenant) return false;
	if (when.sameTenant === false && sameTenant) return false;

	const subjectEnv = parseIsolationClass(request.subject.tags);
	const resourceEnv = parseIsolationClass(request.resource.tags ?? []);
	const sameEnv =
		subjectEnv !== null && resourceEnv !== null && subjectEnv === resourceEnv;
	if (when.sameEnv === true && !sameEnv) return false;
	if (when.sameEnv === false && sameEnv) return false;

	const shared =
		request.resource.tags?.includes("shared:true") === true ||
		request.resource.attributes?.shared === "true";
	if (when.resourceShared === true && !shared) return false;
	if (when.resourceShared === false && shared) return false;

	if (when.resourceKinds && when.resourceKinds.length > 0) {
		if (!when.resourceKinds.includes(request.resource.kind)) return false;
	}
	if (when.subjectTagsAny && when.subjectTagsAny.length > 0) {
		if (!when.subjectTagsAny.some((t) => request.subject.tags.includes(t))) {
			return false;
		}
	}
	if (when.subjectTagsAll && when.subjectTagsAll.length > 0) {
		if (!when.subjectTagsAll.every((t) => request.subject.tags.includes(t))) {
			return false;
		}
	}
	return true;
}

/**
 * Built-in default document: admin+same-env, same-tenant+same-env, or shared+same-env.
 * Cross-env never allowed by default (Environment Network Isolation pack).
 */
export const HOBO_DEFAULT_POLICY_DOCUMENT: RegoLiteDocument = {
	default: "deny",
	rules: [
		{
			effect: "allow",
			actions: ["*"],
			when: { subjectTagsAny: ["role:admin"], sameEnv: true },
			reason: "admin role same-env",
		},
		{
			effect: "allow",
			when: { sameTenant: true, sameEnv: true },
			reason: "same-tenant same-env",
		},
		{
			effect: "allow",
			when: { resourceShared: true, sameEnv: true },
			reason: "shared-resource same-env",
		},
	],
};

/**
 * Environment Network Isolation pack as rego-lite document (explicit deny default).
 */
export const ENV_NETWORK_ISOLATION_REGO_DOCUMENT: RegoLiteDocument = {
	default: "deny",
	rules: [
		{
			effect: "allow",
			when: { sameTenant: true, sameEnv: true },
			reason: "env-isolation: same-tenant same-env",
		},
	],
};

/** @deprecated use HOBO_DEFAULT_POLICY_DOCUMENT */
export const DEFAULT_REGO_LITE_DOCUMENT = HOBO_DEFAULT_POLICY_DOCUMENT;
