import type { JsonObject, JsonValue } from "./json.js";

// The production ACP protocol-connector contract (HOBO-721). HoBo owns NO
// agent SDK by design (sdk-contracts.md §Protocol connectors,
// package-namespaces.md): external agent runtimes integrate through
// `connector(name, { protocol: "acp" })`. HoBo owns connection, identity,
// policy, sandboxing and audit around the protocol calls; the agent runtime
// owns planning and tool orchestration. These are the transport-agnostic
// structural shapes every vendor adapter (M4 siblings) and the in-process
// conformance fixture plug into — the stdio lane wires the same shapes over
// `@agentclientprotocol/sdk`.

// public-contract: the connector protocol token this package implements.
export const ACP_PROTOCOL = "acp";
// public-contract: the ACP protocol major version this connector negotiates.
export const ACP_PROTOCOL_VERSION = 1;

// --- Agent-side surface (what the connector calls on the agent) ---

export interface AcpInitializeResult {
	readonly protocolVersion: number;
	readonly agentCapabilities?: JsonObject;
}

export interface AcpPromptContent {
	readonly type: "text";
	readonly text: string;
}

export interface AcpPromptResult {
	// ACP stop reasons: end_turn | max_tokens | max_turn_requests | refusal |
	// cancelled.
	readonly stopReason: string;
}

// The structural agent connection every adapter provides: the four ACP
// agent methods of the session lifecycle. In-process fixtures implement it
// directly; the stdio lane derives it from ClientSideConnection.
export interface AcpAgentConnection {
	initialize(params: { protocolVersion: number }): Promise<AcpInitializeResult>;
	newSession(params: {
		cwd: string;
		mcpServers: JsonValue[];
	}): Promise<{ sessionId: string }>;
	prompt(params: {
		sessionId: string;
		prompt: AcpPromptContent[];
	}): Promise<AcpPromptResult>;
	cancel(params: { sessionId: string }): Promise<void>;
}

// --- Client-side surface (what the agent calls back on the connector) ---

export interface AcpPermissionOption {
	readonly optionId: string;
	readonly name: string;
	// allow_once | allow_always | reject_once | reject_always.
	readonly kind: string;
}

export interface AcpToolCallRef {
	readonly toolCallId: string;
	readonly title?: string;
	// The HoBo action the tool call maps to (e.g. "deployment:apply",
	// "logs:tail") — what the policy gate classifies.
	readonly rawInput?: JsonObject;
}

export interface AcpPermissionRequest {
	readonly sessionId: string;
	readonly toolCall: AcpToolCallRef;
	readonly options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
	| { readonly outcome: "selected"; readonly optionId: string }
	| { readonly outcome: "cancelled" };

export interface AcpSessionNotification {
	readonly sessionId: string;
	readonly update: JsonObject & { readonly sessionUpdate: string };
}

// The governed client surface the session engine implements and hands to the
// agent: permission requests route through the policy gate; updates land as
// audit facts.
export interface GovernedAcpClient {
	requestPermission(
		params: AcpPermissionRequest,
	): Promise<{ outcome: AcpPermissionOutcome }>;
	sessionUpdate(params: AcpSessionNotification): Promise<void>;
}

// An agent factory receiving the governed client — how in-process fixtures
// and adapters bind the callback channel.
export type AcpAgentFactory = (client: GovernedAcpClient) => AcpAgentConnection;

// --- Identity (ai-native-agent-auth.md) ---

// The agent principal: a brokered connector token bound to an SVID, always
// delegated by a human user — never an ambient credential.
export interface AgentPrincipal {
	readonly kind: "agent";
	readonly id: string;
	readonly svid: string;
	readonly delegatedBy: { readonly kind: "user"; readonly id: string };
}

// --- Audit facts (past-tense, appended by the caller's actor) ---

export type AcpSessionFact =
	| {
			readonly type: "connector.SessionOpened";
			readonly sessionId: string;
			readonly connector: string;
			readonly protocol: typeof ACP_PROTOCOL;
			readonly principal: AgentPrincipal;
	  }
	| {
			readonly type: "agent.PromptSubmitted";
			readonly sessionId: string;
			readonly prompt: string;
	  }
	| {
			readonly type: "agent.ToolPermissionRequested";
			readonly sessionId: string;
			readonly toolCallId: string;
			readonly action: string;
	  }
	| {
			readonly type: "policy.Decided";
			readonly sessionId: string;
			readonly toolCallId: string;
			readonly action: string;
			readonly actionClass: string;
			readonly effect: string;
			readonly reasons: readonly string[];
	  }
	| {
			readonly type: "agent.ToolCallRefused";
			readonly sessionId: string;
			readonly toolCallId: string;
			readonly action: string;
			readonly refusal: string;
	  }
	| {
			readonly type: "agent.SessionUpdated";
			readonly sessionId: string;
			readonly update: string;
	  }
	| {
			readonly type: "agent.TurnCompleted";
			readonly sessionId: string;
			readonly stopReason: string;
	  }
	| {
			readonly type: "connector.SessionClosed";
			readonly sessionId: string;
	  };
