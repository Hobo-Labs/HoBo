import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export const AGENT_GUARDRAILS_SCHEMA = "hobo.agent-guardrails/v1";

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
export type ActionClassMap = { [K in ActionClass]: ActionClassEffect };
export type PolicyEffect = "allow" | "require-approval" | "deny";
export type ActionQuotaMap = Readonly<Record<string, number>>;

export interface AgentGuardrailPolicy {
	readonly schemaVersion: typeof AGENT_GUARDRAILS_SCHEMA;
	readonly agentId: string;
	readonly actionClasses: ActionClassMap;
	readonly allowedApprovers: readonly string[];
	readonly spendCapUsd: number | null;
	readonly actionQuotas: ActionQuotaMap;
}

export interface PolicyDecision {
	readonly effect: PolicyEffect;
	readonly actionClass: ActionClass;
	readonly reasons: readonly string[];
}

export interface ToolPermissionUsage {
	readonly currentSpendUsd: number;
	readonly actionCounts: Readonly<Record<string, number>>;
}

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
	if (normalized.includes("token")) return "token";
	if (normalized.includes("admin")) return "admin";
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

export function parseAgentGuardrailPolicy(
	input: JsonValue,
): AgentGuardrailPolicy {
	if (!isJsonObject(input)) throw new Error("policy must be an object");
	if (!isJsonString(input.agentId) || input.agentId.length === 0) {
		throw new Error("policy.agentId must be a non-empty string");
	}
	const rawClasses = isJsonObject(input.actionClasses)
		? input.actionClasses
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
	const allowedApprovers = isJsonArray(input.allowedApprovers)
		? input.allowedApprovers.filter(isJsonString)
		: [];
	const spendCapUsd =
		input.spendCapUsd === undefined || input.spendCapUsd === null
			? null
			: nonNegativeNumber(input.spendCapUsd, "policy.spendCapUsd");
	const actionQuotas = parseActionQuotas(input.actionQuotas);

	return Object.freeze({
		schemaVersion: AGENT_GUARDRAILS_SCHEMA,
		agentId: input.agentId,
		actionClasses: Object.freeze(actionClasses),
		allowedApprovers: Object.freeze(allowedApprovers),
		spendCapUsd,
		actionQuotas: Object.freeze(actionQuotas),
	});
}

export interface ToolPermissionInput {
	readonly action: string;
	readonly policy: AgentGuardrailPolicy;
	readonly approval?: { readonly approver: string };
	readonly estimatedCostUsd?: number;
	readonly usage?: ToolPermissionUsage;
}

export function evaluateToolPermission(
	input: ToolPermissionInput,
): PolicyDecision {
	const actionClass = classifyActionClass(input.action);
	const classEffect = input.policy.actionClasses[actionClass];
	const reasons = [`action-class:${actionClass}`];

	if (classEffect === "deny") {
		return deny(reasons, actionClass, "class-effect:deny");
	}

	const quota = input.policy.actionQuotas[input.action];
	if (quota !== undefined) {
		if (!input.usage) {
			return deny(reasons, actionClass, "action-quota-usage-missing");
		}
		const used = input.usage.actionCounts[input.action] ?? 0;
		if (used >= quota) {
			return deny(reasons, actionClass, `action-quota-exhausted:${quota}`);
		}
	}

	if (input.policy.spendCapUsd !== null) {
		const currentSpendUsd = input.usage?.currentSpendUsd;
		const estimatedCostUsd = input.estimatedCostUsd;
		if (
			currentSpendUsd === undefined ||
			estimatedCostUsd === undefined ||
			!Number.isFinite(currentSpendUsd) ||
			!Number.isFinite(estimatedCostUsd) ||
			currentSpendUsd < 0 ||
			estimatedCostUsd < 0
		) {
			return deny(reasons, actionClass, "spend-usage-or-estimate-missing");
		}
		if (currentSpendUsd + estimatedCostUsd > input.policy.spendCapUsd) {
			return deny(
				reasons,
				actionClass,
				`spend-cap-exceeded:${input.policy.spendCapUsd}`,
			);
		}
	}

	if (classEffect === "auto-allow") {
		return {
			effect: "allow",
			actionClass,
			reasons: [...reasons, "class-effect:auto-allow"],
		};
	}
	if (
		input.approval &&
		input.policy.allowedApprovers.includes(input.approval.approver)
	) {
		return {
			effect: "allow",
			actionClass,
			reasons: [...reasons, `approved-by:${input.approval.approver}`],
		};
	}
	return deny(
		reasons,
		actionClass,
		input.approval ? "approver-not-allowed" : "approval-required-and-missing",
	);
}

function parseActionQuotas(value: JsonValue | undefined) {
	if (value === undefined || value === null) return {};
	if (!isJsonObject(value)) {
		throw new Error("policy.actionQuotas must be an object");
	}
	const quotas: Record<string, number> = {};
	for (const [action, quota] of Object.entries(value)) {
		if (action.length === 0) {
			throw new Error("policy.actionQuotas keys must be non-empty");
		}
		const parsed = nonNegativeNumber(quota, `policy.actionQuotas.${action}`);
		if (!Number.isInteger(parsed)) {
			throw new Error(`policy.actionQuotas.${action} must be an integer`);
		}
		quotas[action] = parsed;
	}
	return quotas;
}

function nonNegativeNumber(value: JsonValue, path: string): number {
	if (!isJsonNumber(value) || !Number.isFinite(value) || value < 0) {
		throw new Error(`${path} must be a non-negative number`);
	}
	return value;
}

function deny(
	reasons: readonly string[],
	actionClass: ActionClass,
	reason: string,
): PolicyDecision {
	return { effect: "deny", actionClass, reasons: [...reasons, reason] };
}
