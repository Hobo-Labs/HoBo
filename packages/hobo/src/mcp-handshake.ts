/**
 * The MCP handshake of `hobo-mcp`, with no dependencies: the entry point
 * answers `initialize` from this before the full server has loaded, so a
 * host's startup limit (30 seconds in Claude Code) never depends on how long
 * a cold machine takes to load the composed CLI. The full server answers
 * with the same function, so the two answers cannot drift.
 */

// public-contract: the MCP protocol revision this stdio server speaks.
export const HOBO_MCP_PROTOCOL_VERSION = "2025-06-18";
// public-contract: the serverInfo.name MCP clients display and configure by.
export const HOBO_MCP_SERVER_NAME = "hobo-mcp";
// public-contract: the serverInfo.version reported in the MCP handshake.
export const HOBO_MCP_SERVER_VERSION = "0.0.1";
// public-contract: the HOBO_CREDENTIALS value that takes credentials from OpenSesame.
export const OPENSESAME_CREDENTIALS = "opensesame";

/** The `initialize` result: the client's revision, or ours when it names none. */
export function initializeResult(
	requested: string | undefined,
	withSession: boolean,
) {
	return {
		protocolVersion: requested ?? HOBO_MCP_PROTOCOL_VERSION,
		capabilities: withSession ? { tools: {}, resources: {} } : { tools: {} },
		serverInfo: {
			name: HOBO_MCP_SERVER_NAME,
			version: HOBO_MCP_SERVER_VERSION,
		},
	};
}
