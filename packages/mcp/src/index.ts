export {
	type AuthContext,
	type AuthDecisionEvent,
	type AuthResolution,
	authorizedToolNames,
	decideToolCall,
	type InertOutputObservation,
	MCP_EVENTS_SCHEMA_VERSION,
	MCP_TOOL_CALL_DECIDED,
	type McpPrincipal,
	observeToolOutput,
	rebindAgentsOnMigrationEvents,
	resolveAuthContext,
	scopeAuthorizesCapability,
	type ToolDecision,
	type ToolDecisionEffect,
} from "./auth.js";
export {
	INJECTION_CORPUS,
	INJECTION_TARGET_TOOLS,
	type InjectionCase,
	type InjectionVector,
} from "./injection-corpus.js";
export {
	MCP_CONTROL_SURFACE_INTERFACE,
	MCP_CONTROL_SURFACE_PORT,
} from "./port.js";
export {
	createRateLimiter,
	createThrottleEvent,
	MCP_RATE_LIMIT_EVENTS_SCHEMA_VERSION,
	MCP_RATE_LIMITED_CODE,
	MCP_TOOL_CALL_THROTTLED,
	type Quota,
	type RateLimitDecision,
	type RateLimitEvent,
	type RateLimiter,
	type RateLimitPolicy,
	type RateLimitReason,
	rateLimitKey,
} from "./rate-limit.js";
export * from "./secret-capture/index.js";
export {
	type CreateHoboMcpServerOptions,
	createHoboMcpServer,
	type HoboMcpServer,
	type ToolCallInput,
	type ToolCallResult,
} from "./server.js";
export {
	assertToolSurfaceParity,
	type CapabilityScope,
	capabilityForTool,
	deriveToolSurface,
	findTool,
	MCP_TOOL_CALL_VERB,
	MCP_TOOL_PORT,
	MCP_TOOL_SURFACE,
	type ParityReport,
	TOOL_INPUT_SCHEMA,
	type ToolDescriptor,
} from "./tool-surface.js";

// public-contract: the package id consumers assert against.
export const HOBO_MCP_PACKAGE = "@hobo/mcp";
