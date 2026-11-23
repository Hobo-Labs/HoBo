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
	const result = {
		protocolVersion: requested ?? HOBO_MCP_PROTOCOL_VERSION,
		capabilities: withSession ? { tools: {}, resources: {} } : { tools: {} },
		serverInfo: {
			name: HOBO_MCP_SERVER_NAME,
			version: HOBO_MCP_SERVER_VERSION,
		},
	};
	if (!withSession) return result;
	return {
		...result,
		instructions:
			"A HoBo MCP connection does not by itself connect an owner secret store. On initial connection, establish or reuse the owner's store session through HoBo's private owner setup: call choose_secret_store with the project directory as cwd. It reuses an established session, or asks the owner privately (a host form, HoBo's widget, or, where the host shows neither or answers its forms before a person could, a one-time private link) to choose their store and sign in, and returns only a status, the store's name, and for status link the URL to show the owner. On status link, show the owner that URL as given, tell them to open it on any device, then call choose_secret_store again with the same cwd until it reports established; never ask for what the page asks. HoBo verbs then read the provider credentials they need from that session; credential values never reach the agent. If it reports link, secure-form-unavailable or sign-in-needed, do not claim the store is connected. Keep store settings, connection references, and credentials out of chat and agent-visible tool arguments.",
	};
}
