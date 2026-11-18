import {
	type AgentGuardrailPolicy,
	evaluateToolPermission,
	type ToolPermissionUsage,
} from "./policy.js";
import type {
	AcpAgentFactory,
	AcpPermissionOutcome,
	AcpPermissionRequest,
	AcpSessionFact,
	AcpSessionNotification,
	AgentPrincipal,
	GovernedAcpClient,
} from "./types.js";
import { ACP_PROTOCOL, ACP_PROTOCOL_VERSION } from "./types.js";

export const POLICY_REFUSAL = "hobo.policy-refusal/v1";

export interface GovernedSessionOptions {
	readonly connector: string;
	readonly agent: AcpAgentFactory;
	readonly principal: AgentPrincipal;
	readonly policy: AgentGuardrailPolicy;
	readonly approvals?: Record<string, { approver: string }>;
	readonly resolveAction?: (request: AcpPermissionRequest) => string;
	readonly estimateCostUsd?: (request: AcpPermissionRequest) => number;
	readonly initialUsage?: ToolPermissionUsage;
	readonly onFact?: (fact: AcpSessionFact) => void;
	readonly cwd?: string;
}

export interface GovernedSessionResult {
	readonly sessionId: string;
	readonly stopReason: string;
	readonly facts: readonly AcpSessionFact[];
	readonly usage: ToolPermissionUsage;
}

export interface GovernedSession {
	prompt(text: string): Promise<GovernedSessionResult>;
	cancel(): Promise<void>;
	readonly sessionId: string;
}

interface MutableToolPermissionUsage {
	currentSpendUsd: number;
	actionCounts: Record<string, number>;
}

function mutableUsage(
	initial: ToolPermissionUsage | undefined,
): MutableToolPermissionUsage {
	const currentSpendUsd = initial?.currentSpendUsd ?? 0;
	if (!Number.isFinite(currentSpendUsd) || currentSpendUsd < 0) {
		throw new Error(
			"connector-acp: initialUsage.currentSpendUsd must be non-negative",
		);
	}
	const actionCounts = { ...initial?.actionCounts };
	for (const [action, count] of Object.entries(actionCounts)) {
		if (action.length === 0 || !Number.isInteger(count) || count < 0) {
			throw new Error(
				"connector-acp: initialUsage.actionCounts must contain non-negative integers",
			);
		}
	}
	return { currentSpendUsd, actionCounts };
}

function snapshotUsage(usage: MutableToolPermissionUsage): ToolPermissionUsage {
	return Object.freeze({
		currentSpendUsd: usage.currentSpendUsd,
		actionCounts: Object.freeze({ ...usage.actionCounts }),
	});
}

export async function openGovernedSession(
	options: GovernedSessionOptions,
): Promise<GovernedSession> {
	if (options.policy.spendCapUsd !== null && !options.estimateCostUsd) {
		throw new Error(
			"connector-acp: estimateCostUsd is required when spendCapUsd is configured",
		);
	}
	const facts: AcpSessionFact[] = [];
	let cancelled = false;
	const usage = mutableUsage(options.initialUsage);

	const record = (fact: AcpSessionFact) => {
		facts.push(fact);
		options.onFact?.(fact);
	};

	let sessionIdHolder = "";

	const client: GovernedAcpClient = {
		async requestPermission(
			params: AcpPermissionRequest,
		): Promise<{ outcome: AcpPermissionOutcome }> {
			const action = options.resolveAction
				? options.resolveAction(params)
				: String(
						params.toolCall.rawInput?.action ?? params.toolCall.title ?? "",
					);
			record({
				type: "agent.ToolPermissionRequested",
				sessionId: params.sessionId,
				toolCallId: params.toolCall.toolCallId,
				action,
			});
			if (cancelled) {
				return { outcome: { outcome: "cancelled" } };
			}
			const approval = options.approvals?.[action];
			const estimatedCostUsd = options.estimateCostUsd?.(params);
			const decision = evaluateToolPermission(
				approval === undefined
					? {
							action,
							policy: options.policy,
							usage,
							...(estimatedCostUsd === undefined
								? undefined
								: { estimatedCostUsd }),
						}
					: {
							action,
							policy: options.policy,
							approval,
							usage,
							...(estimatedCostUsd === undefined
								? undefined
								: { estimatedCostUsd }),
						},
			);
			record({
				type: "policy.Decided",
				sessionId: params.sessionId,
				toolCallId: params.toolCall.toolCallId,
				action,
				actionClass: decision.actionClass,
				effect: decision.effect,
				reasons: decision.reasons,
			});
			if (decision.effect === "allow") {
				const allow = params.options.find((option) =>
					option.kind.startsWith("allow"),
				);
				if (!allow) {
					return refuse(params, action, "no-allow-option-offered");
				}
				usage.actionCounts[action] = (usage.actionCounts[action] ?? 0) + 1;
				usage.currentSpendUsd += estimatedCostUsd ?? 0;
				return {
					outcome: { outcome: "selected", optionId: allow.optionId },
				};
			}
			return refuse(params, action, decision.reasons.join(";"));
		},

		async sessionUpdate(params: AcpSessionNotification): Promise<void> {
			record({
				type: "agent.SessionUpdated",
				sessionId: params.sessionId,
				update: params.update.sessionUpdate,
			});
		},
	};

	interface PermissionReply {
		outcome: AcpPermissionOutcome;
	}

	function refuse(
		params: AcpPermissionRequest,
		action: string,
		reason: string,
	): PermissionReply {
		const reject = params.options.find((option) =>
			option.kind.startsWith("reject"),
		);
		record({
			type: "agent.ToolCallRefused",
			sessionId: params.sessionId,
			toolCallId: params.toolCall.toolCallId,
			action,
			refusal: `${POLICY_REFUSAL}:${reason}`,
		});
		if (!reject) {
			return { outcome: { outcome: "cancelled" } };
		}
		return { outcome: { outcome: "selected", optionId: reject.optionId } };
	}

	const agent = options.agent(client);
	const initialized = await agent.initialize({
		protocolVersion: ACP_PROTOCOL_VERSION,
	});
	if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
		throw new Error(
			`connector-acp: agent negotiated unsupported protocol version ${initialized.protocolVersion}`,
		);
	}
	const opened = await agent.newSession({
		cwd: options.cwd ?? "/workspace",
		mcpServers: [],
	});
	sessionIdHolder = opened.sessionId;
	record({
		type: "connector.SessionOpened",
		sessionId: opened.sessionId,
		connector: options.connector,
		protocol: ACP_PROTOCOL,
		principal: options.principal,
	});

	return {
		sessionId: opened.sessionId,

		async prompt(text: string): Promise<GovernedSessionResult> {
			record({
				type: "agent.PromptSubmitted",
				sessionId: sessionIdHolder,
				prompt: text,
			});
			const result = await agent.prompt({
				sessionId: sessionIdHolder,
				prompt: [{ type: "text", text }],
			});
			record({
				type: "agent.TurnCompleted",
				sessionId: sessionIdHolder,
				stopReason: result.stopReason,
			});
			record({ type: "connector.SessionClosed", sessionId: sessionIdHolder });
			return {
				sessionId: sessionIdHolder,
				stopReason: result.stopReason,
				facts: [...facts],
				usage: snapshotUsage(usage),
			};
		},

		async cancel(): Promise<void> {
			cancelled = true;
			await agent.cancel({ sessionId: sessionIdHolder });
		},
	};
}

export interface ReplayedSessionState {
	readonly sessionId: string;
	readonly connector: string;
	readonly principal: AgentPrincipal | undefined;
	readonly prompts: readonly string[];
	readonly decisions: ReadonlyArray<{
		toolCallId: string;
		action: string;
		effect: string;
	}>;
	readonly refusals: readonly string[];
	readonly stopReason: string | undefined;
	readonly closed: boolean;
}

export function replaySessionFacts(
	facts: readonly AcpSessionFact[],
): ReplayedSessionState {
	let sessionId = "";
	let connector = "";
	let principal: AgentPrincipal | undefined;
	const prompts: string[] = [];
	const decisions: Array<{
		toolCallId: string;
		action: string;
		effect: string;
	}> = [];
	const refusals: string[] = [];
	let stopReason: string | undefined;
	let closed = false;

	for (const fact of facts) {
		switch (fact.type) {
			case "connector.SessionOpened":
				sessionId = fact.sessionId;
				connector = fact.connector;
				principal = fact.principal;
				break;
			case "agent.PromptSubmitted":
				prompts.push(fact.prompt);
				break;
			case "policy.Decided":
				decisions.push({
					toolCallId: fact.toolCallId,
					action: fact.action,
					effect: fact.effect,
				});
				break;
			case "agent.ToolCallRefused":
				refusals.push(fact.refusal);
				break;
			case "agent.TurnCompleted":
				stopReason = fact.stopReason;
				break;
			case "connector.SessionClosed":
				closed = true;
				break;
			default:
				break;
		}
	}

	return {
		sessionId,
		connector,
		principal,
		prompts,
		decisions,
		refusals,
		stopReason,
		closed,
	};
}
