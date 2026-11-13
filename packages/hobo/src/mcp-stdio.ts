import {
	type AuthContext,
	capabilityForTool,
	type HoboMcpServer,
	MCP_TOOL_SURFACE,
	NO_HOST_SUPPORT,
	negotiateSecretCaptureSupport,
	SECRET_CAPTURE_TOOL_NAMES,
	type SecretCaptureApp,
	type SecretCaptureHostSupport,
	scopeAuthorizesCapability,
} from "@hobo/mcp";
import { isJsonObject, isJsonString, type JsonObject } from "./json.js";

// The MCP stdio protocol layer for the composed `hobo-mcp` binary.
// Newline-delimited JSON-RPC 2.0 per the MCP
// stdio transport; no SDK dependency — the protocol subset the surface needs
// (initialize / tools/list / tools/call / resources/list / resources/read /
// ping) is small enough for the standard library. All verb dispatch flows
// through the injected HoboMcpServer, which routes every call through the
// SAME @hobo/cli command registry the CLI uses (NFR-004 parity) with
// deny-by-default auth ahead of dispatch. With an McpStdioSession the
// secret-capture MCP App's tools and its `ui://` resource are served beside
// the verbs, gated by the same SVID scope; their results never hold a value.

// public-contract: the MCP protocol revision this stdio server speaks.
export const HOBO_MCP_PROTOCOL_VERSION = "2025-06-18";
// public-contract: the serverInfo.name MCP clients display and configure by.
export const HOBO_MCP_SERVER_NAME = "hobo-mcp";
// public-contract: the serverInfo.version reported in the MCP handshake.
export const HOBO_MCP_SERVER_VERSION = "0.0.1";

interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id?: number | string | null;
	readonly method: string;
	readonly params?: JsonObject;
}

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: number | string | null;
	readonly result?: unknown;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: unknown;
	};
}

// The local operator context the stdio binary runs with: the invoking user's
// authority, scoped to exactly the derived tool surface (or the subset named
// in HOBO_MCP_TOOLS). Same trust model as running `hobo` directly — and the
// server still audits every decision and denies unknown tools/scopes.
export function localOperatorAuth(
	env: Record<string, string | undefined> = process.env,
): AuthContext {
	const restrict = env.HOBO_MCP_TOOLS
		? new Set(
				env.HOBO_MCP_TOOLS.split(",")
					.map((name) => name.trim())
					.filter((name) => name.length > 0),
			)
		: null;
	const tools = [
		...MCP_TOOL_SURFACE.map((tool) => tool.name),
		...SECRET_CAPTURE_TOOL_NAMES,
	].filter((name) => restrict === null || restrict.has(name));
	return {
		subject: env.HOBO_MCP_SUBJECT ?? "local-operator",
		tenant: env.HOBO_MCP_TENANT ?? "local",
		principal: {
			kind: "user",
			id: env.HOBO_MCP_SUBJECT ?? "local-operator",
		},
		scope: tools.map((name) => {
			const capability = capabilityForTool(name);
			return {
				port: capability.port,
				resource: capability.resource,
				verbs: [capability.verb],
			};
		}),
	};
}

// The per-connection state of the secret-capture MCP App (ADR-0179
// amendment "Deploy secrets captured by an MCP App into the secret store"):
// the app, and what the client said it supports at `initialize` (MCP Apps,
// URL-mode elicitation). Absent, the server is the CLI verb surface only.
export interface McpStdioSession {
	readonly capture: SecretCaptureApp;
	support: SecretCaptureHostSupport;
}

export function createMcpStdioSession(
	capture: SecretCaptureApp,
): McpStdioSession {
	return { capture, support: NO_HOST_SUPPORT };
}

function captureAllowed(auth: AuthContext, tool: string): boolean {
	return scopeAuthorizesCapability(auth.scope, capabilityForTool(tool));
}

// Handle one JSON-RPC message. Returns the response to write, or null for
// notifications (which get no response per JSON-RPC 2.0).
export async function handleMcpMessage(
	server: HoboMcpServer,
	auth: AuthContext,
	raw: string,
	session?: McpStdioSession,
): Promise<JsonRpcResponse | null> {
	let request: JsonRpcRequest;
	try {
		// SAFETY: assertion required at this I/O or test boundary.
		request = JSON.parse(raw) as JsonRpcRequest;
	} catch {
		return {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "parse error" },
		};
	}

	const id = request.id ?? null;
	const isNotification = request.id === undefined;

	switch (request.method) {
		case "initialize": {
			// SAFETY: assertion required at this I/O or test boundary.
			const requested = (request.params as { protocolVersion?: string })
				?.protocolVersion;
			if (session !== undefined)
				session.support = negotiateSecretCaptureSupport(
					request.params?.capabilities,
				);
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: requested ?? HOBO_MCP_PROTOCOL_VERSION,
					capabilities:
						session === undefined
							? { tools: {} }
							: { tools: {}, resources: {} },
					serverInfo: {
						name: HOBO_MCP_SERVER_NAME,
						version: HOBO_MCP_SERVER_VERSION,
					},
				},
			};
		}
		case "notifications/initialized":
		case "notifications/cancelled":
			return null;
		case "ping":
			return { jsonrpc: "2.0", id, result: {} };
		case "tools/list":
			return {
				jsonrpc: "2.0",
				id,
				result: {
					tools: [
						...server.listTools().map((tool) => ({
							name: tool.name,
							description: `${tool.summary} (role: ${tool.role})`,
							inputSchema: tool.inputSchema,
						})),
						...(session === undefined
							? []
							: session.capture
									.tools(session.support)
									.filter((tool) => captureAllowed(auth, tool.name))),
					],
				},
			};
		case "resources/list":
			return {
				jsonrpc: "2.0",
				id,
				result: {
					resources:
						session === undefined
							? []
							: session.capture.resources(session.support),
				},
			};
		case "resources/read": {
			const uri = request.params?.uri;
			const contents =
				session !== undefined && isJsonString(uri)
					? session.capture.readResource(uri)
					: undefined;
			if (contents === undefined)
				return {
					jsonrpc: "2.0",
					id,
					error: { code: -32002, message: "resource not found" },
				};
			return { jsonrpc: "2.0", id, result: contents };
		}
		case "tools/call": {
			// SAFETY: assertion required at this I/O or test boundary.
			const params = (request.params ?? {}) as {
				name?: unknown;
				arguments?: unknown;
			};
			if (!isJsonString(params.name)) {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: -32602, message: "tools/call requires params.name" },
				};
			}
			if (session?.capture.handles(params.name)) {
				if (!captureAllowed(auth, params.name))
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{
									type: "text",
									text: `MCP_SCOPE_DENIED: ${params.name} is not in this caller's scope.`,
								},
							],
							isError: true,
						},
					};
				const outcome = await session.capture.callTool(
					params.name,
					isJsonObject(params.arguments) ? params.arguments : {},
					session.support,
				);
				// A URL elicitation is a JSON-RPC error by design (-32042); every
				// other outcome is a CallToolResult. Neither holds a secret value.
				return outcome.kind === "error"
					? { jsonrpc: "2.0", id, error: outcome.error }
					: { jsonrpc: "2.0", id, result: outcome.result };
			}
			// SAFETY: assertion required at this I/O or test boundary.
			const args = (params.arguments ?? {}) as {
				cwd?: unknown;
				camp?: unknown;
				args?: unknown;
			};
			const result = await server.callTool(
				params.name,
				{
					...(isJsonString(args.cwd) ? { cwd: args.cwd } : undefined),
					...(isJsonString(args.camp) ? { camp: args.camp } : undefined),
					...(Array.isArray(args.args)
						? {
								args: args.args.filter((a): a is string => isJsonString(a)),
							}
						: undefined),
				},
				auth,
			);
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify(result.output ?? result.error ?? null),
						},
					],
					isError: !result.ok,
				},
			};
		}
		default:
			if (isNotification) {
				return null;
			}
			return {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `method not found: ${request.method}` },
			};
	}
}

// Serve newline-delimited JSON-RPC over the given streams until input ends.
export async function serveMcpStdio(options: {
	readonly server: HoboMcpServer;
	readonly auth: AuthContext;
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
	readonly session?: McpStdioSession;
}): Promise<void> {
	let buffer = "";
	for await (const chunk of options.input) {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				const response = await handleMcpMessage(
					options.server,
					options.auth,
					line,
					options.session,
				);
				if (response !== null) {
					options.output.write(`${JSON.stringify(response)}\n`);
				}
			}
			newline = buffer.indexOf("\n");
		}
	}
}
