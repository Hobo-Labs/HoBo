import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
} from "./json.js";
import {
	createDecision,
	createDecisionRequest,
	createPolicyDecidedEvent,
} from "./policy-ir.js";

export const AGENT_GUARDRAILS_SCHEMA_VERSION = "hobo.agent-guardrails/v1";
export const AGENT_GUARDRAILS_ENGINE_ID =
	"hobo.agent-guardrails/contract@0.1.0";

export const ACTION_CLASSES = Object.freeze([
	"read",
	"write",
	"deploy",
	"destroy",
	"token",
	"admin",
]);

export const ACTION_CLASS_EFFECTS = Object.freeze([
	"auto-allow",
	"require-approval",
	"deny",
]);

const ACTION_CLASS_EFFECT_SET = new Set(ACTION_CLASS_EFFECTS);

export function classifyActionClass(action) {
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

export function parseAgentGuardrailPolicy(input) {
	const source = expectObject(input, "policy");
	const actionClasses = {};
	const rawClasses = expectObject(
		source.actionClasses ?? {},
		"policy.actionClasses",
	);
	for (const actionClass of ACTION_CLASSES) {
		const effect = rawClasses[actionClass] ?? "require-approval";
		if (!ACTION_CLASS_EFFECT_SET.has(effect)) {
			throw new Error(
				`policy.actionClasses.${actionClass} must be auto-allow, require-approval, or deny`,
			);
		}
		actionClasses[actionClass] = effect;
	}

	return {
		schemaVersion: AGENT_GUARDRAILS_SCHEMA_VERSION,
		agentId: expectNonEmptyString(source.agentId, "policy.agentId"),
		actionClasses,
		spendCapUsd:
			source.spendCapUsd === undefined || source.spendCapUsd === null
				? null
				: nonNegativeNumber(source.spendCapUsd, "policy.spendCapUsd"),
		allowedApprovers: arrayOfStrings(
			source.allowedApprovers,
			"policy.allowedApprovers",
		),
		destroyGrant: normalizeDestroyGrant(source.destroyGrant),
	};
}

export function evaluateAgentGuardrail(input) {
	const source = expectObject(input, "input");
	const request = createDecisionRequest(source.request);
	const policy = parseAgentGuardrailPolicy(source.policy);
	const meteringView = normalizeMeteringView(source.meteringView);
	const approval = normalizeApproval(source.approval);
	const enforcementPoint =
		source.enforcementPoint === "runtime" ? "runtime" : "gateway";

	const actionClass = classifyActionClass(request.action);
	const classEffect = policy.actionClasses[actionClass];
	const estimateUsd = readCost(request.context);
	const currentSpendUsd = readAgentSpend(meteringView, policy.agentId);
	const projectedSpendUsd = roundUsd(currentSpendUsd + estimateUsd);

	const state = {
		request,
		policy,
		actionClass,
		classEffect,
		enforcementPoint,
		estimateUsd,
		currentSpendUsd,
		projectedSpendUsd,
		violations: [],
		obligations: [],
		approvals: [],
		supportEvents: [],
	};

	evaluateActionClassGate(state, approval);
	evaluateDestroyProtection(state);
	evaluateSpendCapGate(state, approval);

	const decision = createDecision(request, {
		effect: chooseEffect(state),
		reason: chooseReason(state),
		violations: state.violations,
		approvals: state.approvals,
		obligations: state.obligations,
		evidence: {
			engine: AGENT_GUARDRAILS_ENGINE_ID,
			policyIds: [`agent-guardrail:${policy.agentId}`],
			actionClass,
			enforcementPoint,
		},
	});

	const policyEvent = {
		...createPolicyDecidedEvent({
			request,
			decision,
		}),
		seq: 1,
		audit: {
			actorId: readActorId(request),
			approverId: approval?.approverId ?? null,
			agentId: policy.agentId,
			actionClass,
			enforcementPoint,
			estimatedCostUsd: estimateUsd,
			currentSpendUsd,
			projectedSpendUsd,
			spendCapUsd: policy.spendCapUsd,
		},
	};

	const events = [policyEvent, ...state.supportEvents];
	if (decision.effect === "deny" || decision.effect === "require-approval") {
		events.push(
			makeAgentEvent(request, 2, "agent.GuardrailBlocked", {
				agentId: policy.agentId,
				actionClass,
				enforcementPoint,
				action: request.action,
				effect: decision.effect,
				reason: decision.reason,
				canProceed: false,
			}),
		);
	} else {
		events.push(
			makeAgentEvent(request, 2, "agent.GuardrailCleared", {
				agentId: policy.agentId,
				actionClass,
				enforcementPoint,
				action: request.action,
				effect: decision.effect,
				reason: decision.reason,
				canProceed: true,
			}),
		);
	}

	return {
		schemaVersion: AGENT_GUARDRAILS_SCHEMA_VERSION,
		actionClass,
		decision,
		events,
	};
}

export function rebuildAgentGuardrailState(eventsInput) {
	const events = sortEvents(eventsInput);
	const state = {
		policyDecision: null,
		blocked: null,
		cleared: null,
		obligationsSatisfied: new Map(),
		canProceed: false,
	};

	for (const event of events) {
		switch (event.type) {
			case "policy.Decided":
				state.policyDecision = event.data;
				break;
			case "agent.GuardrailBlocked":
				state.blocked = event.data;
				state.canProceed = false;
				break;
			case "agent.GuardrailCleared":
				state.cleared = event.data;
				state.canProceed = event.data.canProceed === true;
				break;
			case "policy.ObligationSatisfied":
				state.obligationsSatisfied.set(event.data.id, event.data);
				break;
			default:
				break;
		}
	}

	return state;
}

export function canAgentProceed(eventsInput) {
	const rebuilt = rebuildAgentGuardrailState(eventsInput);
	const decision = rebuilt.policyDecision;
	if (!decision) {
		return { canProceed: false, reason: "missing policy.Decided" };
	}

	if (decision.effect === "deny") {
		return { canProceed: false, reason: decision.reason };
	}

	if (decision.effect === "require-approval") {
		const required = decision.obligations.find(
			(obligation) =>
				obligation.kind === "agent.approval.required" ||
				obligation.kind === "spend.agent-cap-approval",
		);
		if (!required) {
			return { canProceed: false, reason: "missing approval obligation" };
		}
		const satisfied = rebuilt.obligationsSatisfied.get(required.id);
		const matches =
			satisfied?.effectRef === required.effectRef &&
			satisfied?.agentId === required.agentId &&
			(required.action === undefined || satisfied?.action === required.action);
		return {
			canProceed: Boolean(matches),
			reason: matches
				? "approval satisfied"
				: "approval obligation unsatisfied",
		};
	}

	return {
		canProceed: rebuilt.cleared?.canProceed === true,
		reason:
			rebuilt.cleared?.canProceed === true
				? decision.reason
				: "guardrail not cleared",
	};
}

function evaluateActionClassGate(state, approval) {
	if (state.classEffect === "deny") {
		state.violations.push(
			`${state.actionClass} actions are denied for ${state.policy.agentId}`,
		);
		return;
	}

	if (state.classEffect !== "require-approval") {
		return;
	}

	if (!approval) {
		state.obligations.push({
			kind: "agent.approval.required",
			id: approvalObligationId(state.request, state.policy.agentId),
			effectRef: effectRef(state.request, state.policy.agentId),
			agentId: state.policy.agentId,
			actionClass: state.actionClass,
			action: state.request.action,
			enforcementPoint: state.enforcementPoint,
		});
		return;
	}

	if (approval.decision === "denied") {
		state.violations.push(`approval denied by ${approval.approverId}`);
		return;
	}

	if (
		state.policy.allowedApprovers.length > 0 &&
		!state.policy.allowedApprovers.includes(approval.approverId)
	) {
		state.violations.push(`${approval.approverId} is not an allowed approver`);
		return;
	}

	state.approvals.push({
		kind: "agent.approval.required",
		approverId: approval.approverId,
		approvedAt: approval.approvedAt,
		actionClass: state.actionClass,
		action: state.request.action,
	});
}

function evaluateDestroyProtection(state) {
	if (state.actionClass !== "destroy") {
		return;
	}

	const grant = state.policy.destroyGrant;
	const contextGrant = state.request.context?.destroyGrant;
	const granted =
		grant?.granted === true ||
		contextGrant?.granted === true ||
		state.request.context?.destroyGranted === true;

	if (!granted) {
		state.violations.push("destroy actions require an explicit destroy grant");
		state.supportEvents.push(
			makeAgentEvent(state.request, 0, "agent.DestroyDenied", {
				agentId: state.policy.agentId,
				action: state.request.action,
				reason: "missing explicit destroy grant",
			}),
		);
	}
}

function evaluateSpendCapGate(state, approval) {
	if (state.policy.spendCapUsd === null || state.estimateUsd <= 0) {
		return;
	}
	if (state.projectedSpendUsd <= state.policy.spendCapUsd) {
		return;
	}

	state.supportEvents.push(
		makeAgentEvent(state.request, 0, "spend.CapGateEvaluated", {
			agentId: state.policy.agentId,
			spendCapUsd: state.policy.spendCapUsd,
			currentSpendUsd: state.currentSpendUsd,
			projectedSpendUsd: state.projectedSpendUsd,
			capExceeded: true,
		}),
	);

	if (!approval) {
		state.obligations.push({
			kind: "spend.agent-cap-approval",
			id: spendCapObligationId(state.request, state.policy.agentId),
			effectRef: effectRef(state.request, state.policy.agentId),
			agentId: state.policy.agentId,
			spendCapUsd: state.policy.spendCapUsd,
			currentSpendUsd: state.currentSpendUsd,
			projectedSpendUsd: state.projectedSpendUsd,
			allowedApprovers: state.policy.allowedApprovers,
		});
		return;
	}

	if (approval.decision === "denied") {
		state.violations.push(`approval denied by ${approval.approverId}`);
		return;
	}

	if (
		state.policy.allowedApprovers.length > 0 &&
		!state.policy.allowedApprovers.includes(approval.approverId)
	) {
		state.violations.push(`${approval.approverId} is not an allowed approver`);
		return;
	}

	state.approvals.push({
		kind: "spend.agent-cap-approval",
		approverId: approval.approverId,
		approvedAt: approval.approvedAt,
		spendCapUsd: state.policy.spendCapUsd,
		projectedSpendUsd: state.projectedSpendUsd,
	});
}

function chooseEffect(state) {
	if (state.violations.length > 0) {
		return "deny";
	}
	if (state.obligations.length > 0) {
		return "require-approval";
	}
	return "allow";
}

function chooseReason(state) {
	if (state.violations.some((violation) => violation.includes("destroy"))) {
		return "destroy denied without explicit grant";
	}
	if (state.violations.length > 0) {
		return state.violations[0];
	}
	if (
		state.obligations.some(
			(obligation) => obligation.kind === "spend.agent-cap-approval",
		)
	) {
		return "agent spendCapUsd requires approval";
	}
	if (
		state.obligations.some(
			(obligation) => obligation.kind === "agent.approval.required",
		)
	) {
		return `${state.actionClass} action requires approval`;
	}
	return `${state.actionClass} action allowed`;
}

function normalizeDestroyGrant(value) {
	if (value === undefined || value === null) {
		return { granted: false, grantId: null };
	}
	const source = expectObject(value, "policy.destroyGrant");
	return {
		granted: source.granted === true,
		grantId:
			source.grantId === undefined || source.grantId === null
				? null
				: String(source.grantId),
	};
}

interface MeteringView {
	seq: number;
	scopeCosts: JsonBag;
}

function normalizeMeteringView(value): MeteringView {
	if (value === undefined || value === null) {
		return { seq: 0, scopeCosts: {} };
	}
	const source = expectObject(value, "meteringView");
	return {
		seq: Number.isFinite(source.seq) ? source.seq : 0,
		scopeCosts:
			source.scopeCosts && isJsonObject(source.scopeCosts)
				? { ...source.scopeCosts }
				: {},
	};
}

function normalizeApproval(value) {
	if (value === undefined || value === null) {
		return null;
	}
	const source = expectObject(value, "approval");
	const decision = source.decision;
	if (decision !== "approved" && decision !== "denied") {
		throw new Error("approval.decision must be approved or denied");
	}
	return {
		decision,
		approverId: expectNonEmptyString(source.approverId, "approval.approverId"),
		approvedAt: expectNonEmptyString(source.approvedAt, "approval.approvedAt"),
	};
}

function readAgentSpend(meteringView, agentId) {
	const key = `agent:${agentId}`;
	const entry = meteringView.scopeCosts[key];
	if (isJsonNumber(entry)) {
		return roundUsd(entry);
	}
	if (!isJsonObject(entry)) {
		return 0;
	}
	const cost = entry["cost"];
	return isJsonNumber(cost) ? roundUsd(cost) : 0;
}

function readCost(context) {
	const source = context && isJsonObject(context) ? context : {};
	const estimate = source.costEstimateUsd ?? source.estimatedCostUsd ?? 0;
	return roundUsd(estimate);
}

function readActorId(request) {
	return (
		request.context?.actorId ??
		request.subject.delegatedBy ??
		request.subject.id
	);
}

function approvalObligationId(request, agentId) {
	return `approval:${agentId}:${request.action}`;
}

function spendCapObligationId(request, agentId) {
	return `spend-cap:${agentId}:${request.action}`;
}

function effectRef(request, agentId) {
	return `agent-guardrail:${agentId}:${request.action}`;
}

function makeAgentEvent(request, seq, type, data) {
	return {
		type,
		seq,
		occurredAt: request.context?.occurredAt ?? "2026-07-01T00:00:00.000Z",
		correlationId: request.context?.correlationId ?? request.inputHash,
		data,
	};
}

function sortEvents(eventsInput) {
	return [...eventsInput].sort(
		(left, right) => (left.seq ?? 0) - (right.seq ?? 0),
	);
}

function expectObject(value, path) {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value;
}

function expectNonEmptyString(value, path) {
	if (!isJsonString(value) || value.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value.trim();
}

function arrayOfStrings(value, path) {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
		throw new Error(`${path} must be an array of strings`);
	}
	return [...value];
}

function nonNegativeNumber(value, path) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(`${path} must be a non-negative number`);
	}
	return roundUsd(number);
}

function roundUsd(value) {
	return Math.round(Number(value) * 100) / 100;
}
