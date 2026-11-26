import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

// The connector's policy gate, promoted from the s3-07-agent-guardrails
// draft proof: every agent tool-permission request is classified into an
// action class and decided against the parsed guardrail policy BEFORE any
// grant reaches the agent. Deny-ceiling semantics: effects only ever rank
// DOWN (deny < require-approval < allow); unknown/unparseable inputs fail
// closed.

// public-contract: the guardrail policy document schema id.
export const AGENT_GUARDRAILS_SCHEMA = "hobo.agent-guardrails/v1";

// The action classes agent tool calls collapse into (s3-07 taxonomy).
export const ACTION_CLASSES = [
	"read",
	"write",
	"deploy",
	"destroy",
	"token",
	"admin",
] as const;

export type ActionClass = (typeof ACTION_CLASSES)[number];

export type ActionClassEffect = "auto-allow" | "require-approval" | "deny";

export type ActionClassMap = {
	[K in ActionClass]: ActionClassEffect;
};

export type PolicyEffect = "allow" | "require-approval" | "deny";

export interface AgentGuardrailPolicy {
	readonly schemaVersion: typeof AGENT_GUARDRAILS_SCHEMA;
	readonly agentId: string;
	readonly actionClasses: ActionClassMap;
	readonly allowedApprovers: readonly string[];
}

export interface PolicyDecision {
	readonly effect: PolicyEffect;
	readonly actionClass: ActionClass;
	readonly reasons: readonly string[];
}

// Map a raw agent action string onto its class — unknown verbs default to
// `write` (never silently `read`): fail toward the stricter class.
export function classifyActionClass(action: string): ActionClass {
	const normalized = String(action ?? "").toLowerCase();
	if (
		normalized.includes("destroy") ||
		normalized.includes("resource.delete")
	) {
		return "destroy";
	}
	if (
		normalized.includes("deployment:apply") ||
		normalized.includes("deployment:promote") ||
		normalized.includes("deployment:rollback")
	) {
		return "deploy";
	}
	if (normalized.includes("token")) {
		return "token";
	}
	if (normalized.includes("admin")) {
		return "admin";
	}
	if (
		normalized.includes(":get") ||
		normalized.includes(":list") ||
		normalized.includes(":read") ||
		normalized.includes(":inspect") ||
		normalized.includes(":tail")
	) {
		return "read";
	}
	return "write";
}

/**
 * Parse-don't-validate boundary for guardrail policies: an untrusted policy
 * document becomes a frozen derived policy or throws — a missing class
 * defaults to `require-approval`, never to allow.
 */
export function parseAgentGuardrailPolicy(
	input: JsonValue,
): AgentGuardrailPolicy {
	if (!isJsonObject(input)) {
		throw new Error("policy must be an object");
	}
	const source = input;
	if (!isJsonString(source.agentId) || source.agentId.length === 0) {
		throw new Error("policy.agentId must be a non-empty string");
	}
	const rawClasses = isJsonObject(source.actionClasses)
		? source.actionClasses
		: {};
	const actionClasses: ActionClassMap = {
		read: "require-approval",
		write: "require-approval",
		deploy: "require-approval",
		destroy: "require-approval",
		token: "require-approval",
		admin: "require-approval",
	};
	for (const actionClass of ACTION_CLASSES) {
		const effect = rawClasses[actionClass] ?? "require-approval";
		if (
			effect !== "auto-allow" &&
			effect !== "require-approval" &&
			effect !== "deny"
		) {
			throw new Error(
				`policy.actionClasses.${actionClass} must be auto-allow, require-approval, or deny`,
			);
		}
		actionClasses[actionClass] = effect;
	}
	const approvers = isJsonArray(source.allowedApprovers)
		? source.allowedApprovers.filter(isJsonString)
		: [];

	return Object.freeze({
		schemaVersion: AGENT_GUARDRAILS_SCHEMA,
		agentId: source.agentId,
		actionClasses: Object.freeze(actionClasses),
		allowedApprovers: Object.freeze(approvers),
	});
}

export interface ToolPermissionInput {
	readonly action: string;
	readonly policy: AgentGuardrailPolicy;
	// A recorded human approval for THIS action (require-approval lane).
	readonly approval?: { readonly approver: string };
}

// Decide one tool-permission request. Deny-ceiling: the decision can never
// rank above what the class effect grants, and anything unresolved fails
// closed to deny.
export function evaluateToolPermission(
	input: ToolPermissionInput,
): PolicyDecision {
	const actionClass = classifyActionClass(input.action);
	const classEffect = input.policy.actionClasses[actionClass];
	const reasons: string[] = [`action-class:${actionClass}`];

	if (classEffect === "deny") {
		reasons.push("class-effect:deny");
		return { effect: "deny", actionClass, reasons };
	}
	if (classEffect === "auto-allow") {
		reasons.push("class-effect:auto-allow");
		return { effect: "allow", actionClass, reasons };
	}
	// require-approval: an approval from an allowed approver upgrades to
	// allow; anything else stays below the ceiling and FAILS CLOSED.
	if (
		input.approval &&
		input.policy.allowedApprovers.includes(input.approval.approver)
	) {
		reasons.push(`approved-by:${input.approval.approver}`);
		return { effect: "allow", actionClass, reasons };
	}
	reasons.push(
		input.approval ? "approver-not-allowed" : "approval-required-and-missing",
	);
	return { effect: "deny", actionClass, reasons };
}
