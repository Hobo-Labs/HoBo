export {
	buildConnectorTokenRequest,
	type ConnectorTokenBroker,
	type ConnectorTokenRequest,
	TOKEN_EXCHANGE_GRANT,
} from "./broker.js";
export {
	createFixtureAcpAgent,
	type FixtureAcpAgent,
	type FixtureAgentOptions,
} from "./fixture-agent.js";
export {
	type AcpConnectorBinding,
	type AcpConnectorDeclaration,
	type AcpConnectorManifestEntry,
	acpConnector,
	CONNECTOR_ENTRY_TYPE,
	lowerAcpConnector,
} from "./lowering.js";
export {
	ACTION_CLASSES,
	type ActionClass,
	type ActionClassEffect,
	type ActionClassMap,
	AGENT_GUARDRAILS_SCHEMA,
	type AgentGuardrailPolicy,
	classifyActionClass,
	evaluateToolPermission,
	type PolicyDecision,
	type PolicyEffect,
	parseAgentGuardrailPolicy,
	type ToolPermissionInput,
} from "./policy.js";
export {
	type AgentSandboxPosture,
	parseSandboxPosture,
	SANDBOX_POSTURE_SCHEMA,
	scrubEnvironment,
} from "./sandbox.js";
export {
	type GovernedSession,
	type GovernedSessionOptions,
	type GovernedSessionResult,
	openGovernedSession,
	POLICY_REFUSAL,
	type ReplayedSessionState,
	replaySessionFacts,
} from "./session.js";
export {
	ACP_AGENT_SPAWN_FAILED,
	ACP_SDK_MISSING,
	AcpAgentSpawnError,
	AcpSdkMissingError,
	connectAcpAgentOverStdio,
	type StdioAgentHandle,
	type StdioAgentOptions,
} from "./stdio.js";
export {
	ACP_PROTOCOL,
	ACP_PROTOCOL_VERSION,
	type AcpAgentConnection,
	type AcpAgentFactory,
	type AcpInitializeResult,
	type AcpPermissionOption,
	type AcpPermissionOutcome,
	type AcpPermissionRequest,
	type AcpPromptContent,
	type AcpPromptResult,
	type AcpSessionFact,
	type AcpSessionNotification,
	type AcpToolCallRef,
	type AgentPrincipal,
	type GovernedAcpClient,
} from "./types.js";

// public-contract: the package id consumers assert against.
export const HOBO_CONNECTOR_ACP_PACKAGE = "@hobo/connector-acp";
