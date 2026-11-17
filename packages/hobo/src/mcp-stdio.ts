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
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

// public-contract:
export const HOBO_MCP_PROTOCOL_VERSION = "2025-06-18";
// public-contract:
export const HOBO_MCP_SERVER_NAME = "hobo-mcp";
// public-contract:
export const HOBO_MCP_SERVER_VERSION = "0.0.1";

type JsonRpcValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonRpcValue[]
	| { readonly [key: string]: JsonRpcValue | undefined };

type CliToolArguments = { cwd?: string; camp?: string; args?: string[] };

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: number | string | null;
	readonly result?: JsonRpcValue;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: JsonRpcValue;
	};
}

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

export async function handleMcpMessage(
	server: HoboMcpServer,
	auth: AuthContext,
	raw: string,
	session?: McpStdioSession,
): Promise<JsonRpcResponse | null> {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "parse error" },
		};
	}
	if (
		!isJsonObject(parsed) ||
		parsed.jsonrpc !== "2.0" ||
		!isJsonString(parsed.method)
	)
		return {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "invalid request" },
		};
	const requestId = parsed.id;
	if (
		requestId !== undefined &&
		requestId !== null &&
		!isJsonString(requestId) &&
		!(isJsonNumber(requestId) && Number.isFinite(requestId))
	)
		return {
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: "invalid request" },
		};
	const id = requestId ?? null;
	const isNotification = requestId === undefined;
	const params = isJsonObject(parsed.params) ? parsed.params : {};

	switch (parsed.method) {
		case "initialize": {
			const requested = isJsonString(params.protocolVersion)
				? params.protocolVersion
				: undefined;
			if (session !== undefined)
				session.support = negotiateSecretCaptureSupport(params.capabilities);
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
			const uri = params.uri;
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
			if (!isJsonString(params.name)) {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: -32602, message: "tools/call requires params.name" },
				};
			}
			if (session?.capture.handles(params.name)) {
				const authorization = await server.authorizeCaptureTool(
					params.name,
					auth,
				);
				if (!authorization.ok)
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{
									type: "text",
									text: `${authorization.code}: ${authorization.error?.message ?? "Capture authorization failed."}`,
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
				return outcome.kind === "error"
					? { jsonrpc: "2.0", id, error: outcome.error }
					: { jsonrpc: "2.0", id, result: outcome.result };
			}
			const args = isJsonObject(params.arguments) ? params.arguments : {};
			const input: CliToolArguments = {};
			if (isJsonString(args.cwd)) input.cwd = args.cwd;
			if (isJsonString(args.camp)) input.camp = args.camp;
			if (Array.isArray(args.args)) input.args = args.args.filter(isJsonString);
			const result = await server.callTool(params.name, input, auth);
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
				error: { code: -32601, message: `method not found: ${parsed.method}` },
			};
	}
}

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
