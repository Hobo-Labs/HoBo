import { type AgentGuardrailPolicy, evaluateToolPermission } from "./policy.js";
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

// public-contract: the structured refusal an agent sees on policy denial.
export const POLICY_REFUSAL = "hobo.policy-refusal/v1";

export interface GovernedSessionOptions {
	// The connector target name (the manifest key).
	readonly connector: string;
	// The agent adapter — a factory receiving the governed client.
	readonly agent: AcpAgentFactory;
	// The SVID-bound, user-delegated agent principal (broker output).
	readonly principal: AgentPrincipal;
	// The parsed guardrail policy the permission gate decides against.
	readonly policy: AgentGuardrailPolicy;
	// Recorded human approvals keyed by action (require-approval lane).
	readonly approvals?: Record<string, { approver: string }>;
	// Receives every past-tense fact for the caller's single-writer actor to
	// append to the event store.
	readonly onFact?: (fact: AcpSessionFact) => void;
	readonly cwd?: string;
}

export interface GovernedSessionResult {
	readonly sessionId: string;
	readonly stopReason: string;
	readonly facts: readonly AcpSessionFact[];
}

export interface GovernedSession {
	// Run one governed prompt turn end to end.
	prompt(text: string): Promise<GovernedSessionResult>;
	// Cancel the in-flight turn (the agent must answer pending permission
	// requests with the cancelled outcome per ACP).
	cancel(): Promise<void>;
	readonly sessionId: string;
}

// Open a governed ACP session: initialize + session/new against the agent,
// with every subsequent prompt turn audited — prompt, streamed updates,
// permission requests (decided by the policy gate, deny fails closed and is
// VISIBLE to the agent as a structured refusal), and the final stop reason
// all land as past-tense facts.
export async function openGovernedSession(
	options: GovernedSessionOptions,
): Promise<GovernedSession> {
	const facts: AcpSessionFact[] = [];
	let cancelled = false;

	const record = (fact: AcpSessionFact) => {
		facts.push(fact);
		options.onFact?.(fact);
	};

	let sessionIdHolder = "";

	const client: GovernedAcpClient = {
		async requestPermission(
			params: AcpPermissionRequest,
		): Promise<{ outcome: AcpPermissionOutcome }> {
			const action = String(
				params.toolCall.rawInput?.action ?? params.toolCall.title ?? "",
			);
			record({
				type: "agent.ToolPermissionRequested",
				sessionId: params.sessionId,
				toolCallId: params.toolCall.toolCallId,
				action,
			});
			if (cancelled) {
				// ACP: a cancelled turn MUST answer pending permission requests
				// with the cancelled outcome.
				return { outcome: { outcome: "cancelled" } };
			}
			const approval = options.approvals?.[action];
			const decision = evaluateToolPermission(
				approval === undefined
					? { action, policy: options.policy }
					: { action, policy: options.policy, approval },
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
					// The agent offered no allow option — fail closed.
					return refuse(params, "no-allow-option-offered");
				}
				return {
					outcome: { outcome: "selected", optionId: allow.optionId },
				};
			}
			return refuse(params, decision.reasons.join(";"));
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
		reason: string,
	): PermissionReply {
		const reject = params.options.find((option) =>
			option.kind.startsWith("reject"),
		);
		record({
			type: "agent.ToolCallRefused",
			sessionId: params.sessionId,
			toolCallId: params.toolCall.toolCallId,
			action: String(
				params.toolCall.rawInput?.action ?? params.toolCall.title ?? "",
			),
			refusal: `${POLICY_REFUSAL}:${reason}`,
		});
		if (!reject) {
			// No reject option offered either — the only fail-closed response
			// left is the cancelled outcome.
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

/**
 * Rebuild a session's state purely from its recorded facts — the audit
 * acceptance: the governed session is REPLAYABLE from the log with no
 * process memory.
 */
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
