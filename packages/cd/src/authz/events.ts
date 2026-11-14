// The recorded authorization decision (I10). Plan 0024 A.6 names no event or
// stream for delivery authorization, so they are owned here and reported to
// the coordinator as a contract-amendment candidate (an `AuthzDecisionRecord`
// message in cd.proto). Until then they are wire contract of `@hobo/cd/authz`.
//
// The event type is the policy IR's own `policy.Decided` fact, so audit tools
// that already read policy decisions read delivery decisions unchanged. One
// stream per governed resource keeps writers apart and lets the separation of
// duties check read exactly the history it needs.
import { createHash } from "node:crypto";
import { POLICY_DECIDED_EVENT_TYPE } from "@hobo/contracts";
import type { JsonObject, JsonValue } from "@hobo/core";
import type { CdAction } from "../ports.js";
import { isJsonObject, isText } from "./json.js";
import { isCdAction } from "./rules.js";

// public-contract: event type of a recorded CD authorization decision.
export const AUTHZ_DECIDED_EVENT = POLICY_DECIDED_EVENT_TYPE;

// public-contract: schema id of the decision body.
export const AUTHZ_DECISION_SCHEMA = "hobo.cd.authz-decision/v1" as const;

// public-contract: decision streams, one per governed resource.
export const AUTHZ_STREAMS = Object.freeze({
	resource: (kind: string, id: string) =>
		`cd-authz-${kind.replace(/[^a-z0-9]+/giu, "-")}-${createHash("sha256")
			.update(`${kind}\u0000${id}`)
			.digest("hex")
			.slice(0, 32)}`,
});

export type AuthzEffect =
	| "allow"
	| "allow-degraded"
	| "deny"
	| "warn"
	| "mutate"
	| "require-approval";

/**
 * The parsed decision body. Parse-don't-validate: `parseAuthzDecision` is the
 * only way to obtain one from journal JSON, so a malformed or foreign
 * `policy.Decided` body never reaches the separation-of-duties check.
 */
export type AuthzDecision = Readonly<{
	schemaVersion: typeof AUTHZ_DECISION_SCHEMA;
	decisionId: string;
	action: CdAction;
	principal: string;
	effect: AuthzEffect;
	proposalOnly: boolean;
	reason: string;
	resource: Readonly<{ kind: string; id: string }>;
	decidedAt: string;
	policyIds: readonly string[];
	packId: string;
	packVersion: string;
	inputHash: string;
	/** The secret-scrubbed subject (I9); `redacted` lists dropped members. */
	subject: JsonObject;
	redacted: readonly string[];
}>;

const EFFECTS: ReadonlySet<string> = new Set([
	"allow",
	"allow-degraded",
	"deny",
	"warn",
	"mutate",
	"require-approval",
]);

function isEffect(value: string): value is AuthzEffect {
	return EFFECTS.has(value);
}

function text(value: JsonValue | undefined): string | undefined {
	return isText(value) ? value : undefined;
}

function texts(value: JsonValue | undefined): string[] {
	return Array.isArray(value) ? value.filter(isText) : [];
}

export function parseAuthzDecision(
	data: JsonValue | undefined,
): AuthzDecision | undefined {
	if (!isJsonObject(data)) return undefined;
	if (data.schemaVersion !== AUTHZ_DECISION_SCHEMA) return undefined;
	const action = text(data.action);
	const effect = text(data.effect);
	const decisionId = text(data.decisionId);
	const principal = text(data.principal);
	const resource = data.resource;
	if (
		action === undefined ||
		!isCdAction(action) ||
		effect === undefined ||
		!isEffect(effect) ||
		decisionId === undefined ||
		principal === undefined ||
		!isJsonObject(resource)
	)
		return undefined;
	return {
		schemaVersion: AUTHZ_DECISION_SCHEMA,
		decisionId,
		action,
		principal,
		effect,
		proposalOnly: data.proposalOnly === true,
		reason: text(data.reason) ?? "",
		resource: {
			kind: text(resource.kind) ?? "",
			id: text(resource.id) ?? "",
		},
		decidedAt: text(data.decidedAt) ?? "",
		policyIds: texts(data.policyIds),
		packId: text(data.packId) ?? "",
		packVersion: text(data.packVersion) ?? "",
		inputHash: text(data.inputHash) ?? "",
		subject: isJsonObject(data.subject) ? data.subject : {},
		redacted: texts(data.redacted),
	};
}

export function authzDecisionJson(decision: AuthzDecision): JsonObject {
	return {
		schemaVersion: decision.schemaVersion,
		decisionId: decision.decisionId,
		action: decision.action,
		principal: decision.principal,
		effect: decision.effect,
		proposalOnly: decision.proposalOnly,
		reason: decision.reason,
		resource: { kind: decision.resource.kind, id: decision.resource.id },
		decidedAt: decision.decidedAt,
		policyIds: [...decision.policyIds],
		packId: decision.packId,
		packVersion: decision.packVersion,
		inputHash: decision.inputHash,
		subject: decision.subject,
		redacted: [...decision.redacted],
	};
}

/** An effect that lets the action proceed outright. */
export function isGrant(decision: AuthzDecision): boolean {
	return decision.effect !== "deny" && !decision.proposalOnly;
}
