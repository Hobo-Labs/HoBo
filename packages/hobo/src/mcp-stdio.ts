import { AsyncLocalStorage } from "node:async_hooks";
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
import { z } from "zod";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { initializeResult } from "./mcp-handshake.js";
import {
	type ClientRequest,
	NO_STORE_CHOICE_SUPPORT,
	negotiateStoreChoiceSupport,
	STORE_CHOICE_TOOL_NAMES,
	type StoreChoiceApp,
	type StoreChoiceSupport,
} from "./mcp-store-choice.js";

export {
	HOBO_MCP_PROTOCOL_VERSION,
	HOBO_MCP_SERVER_NAME,
	HOBO_MCP_SERVER_VERSION,
} from "./mcp-handshake.js";

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
		...STORE_CHOICE_TOOL_NAMES,
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
	/** The secret-store choice: an elicitation, a widget or the host's picker. */
	readonly storeChoice?: StoreChoiceApp;
	storeSupport: StoreChoiceSupport;
	/** Send a request to the client (set by the transport: elicitation). */
	request?: ClientRequest;
}

export function createMcpStdioSession(
	capture: SecretCaptureApp,
	storeChoice?: StoreChoiceApp,
): McpStdioSession {
	return {
		capture,
		support: NO_HOST_SUPPORT,
		storeSupport: NO_STORE_CHOICE_SUPPORT,
		...(storeChoice !== undefined ? { storeChoice } : undefined),
	};
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
			if (session !== undefined) {
				session.support = negotiateSecretCaptureSupport(params.capabilities);
				session.storeSupport = negotiateStoreChoiceSupport(params.capabilities);
			}
			return {
				jsonrpc: "2.0",
				id,
				result: initializeResult(requested, session !== undefined),
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
						...(session?.storeChoice === undefined
							? []
							: session.storeChoice
									.tools(session.storeSupport)
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
							: [
									...session.capture.resources(session.support),
									...(session.storeChoice?.resources(session.storeSupport) ??
										[]),
								],
				},
			};
		case "resources/read": {
			const uri = params.uri;
			const contents =
				session !== undefined && isJsonString(uri)
					? (session.capture.readResource(uri) ??
						session.storeChoice?.readResource(uri))
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
			if (session?.storeChoice?.handles(params.name)) {
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
				const outcome = await session.storeChoice.callTool(
					params.name,
					isJsonObject(params.arguments) ? params.arguments : {},
					session.storeSupport,
					session.request,
				);
				return { jsonrpc: "2.0", id, result: outcome };
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

/** A JSON-RPC request id (a string or a number), as the map key we keep. */
const REQUEST_ID = z.union([z.string(), z.number()]).transform(String);

// Two-way: a tool call may send the client a request (an elicitation) and
// wait for its answer, so each incoming request is handled without blocking
// the reader, and a response to one of the server's requests is routed back.
/** The owner's time to answer one form (HOBO_OWNER_FORM_WAIT_MS), 10 minutes by default. */
export function ownerFormWaitMs(env: NodeJS.ProcessEnv): number {
	const parsed = z.coerce
		.number()
		.int()
		.positive()
		// Node fires a longer timer at once.
		.max(2_147_483_647)
		.safeParse(env.HOBO_OWNER_FORM_WAIT_MS);
	return parsed.success ? parsed.data : 600_000;
}

export async function serveMcpStdio(options: {
	readonly server: HoboMcpServer;
	readonly auth: AuthContext;
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
	readonly session?: McpStdioSession;
	/**
	 * How long a form this server asks the host for may stay unanswered.
	 * A host can accept a form and never show it (the live run's form sat
	 * open for 30 minutes); past this, the server withdraws it and the run
	 * goes on with its refusal and the link. Default: HOBO_OWNER_FORM_WAIT_MS,
	 * else 10 minutes (under the 30 minutes `.mcp.json` gives a call).
	 */
	readonly formDeadlineMs?: number;
}): Promise<void> {
	const formDeadlineMs = options.formDeadlineMs ?? ownerFormWaitMs(process.env);
	const write = (message: JsonObject | JsonRpcResponse) =>
		options.output.write(`${JSON.stringify(message)}\n`);
	const waiting = new Map<string, (answer: JsonValue | undefined) => void>();
	// Which of the client's requests each of ours was sent for, so a
	// cancelled tool call withdraws exactly its own prompts (the host's
	// cancel is the event; the form deadline above is the one timer).
	const asking = new AsyncLocalStorage<Set<string>>();
	const askedFor = new Map<string, Set<string>>();
	let next = 0;
	if (options.session !== undefined)
		options.session.request = (method, params) => {
			next += 1;
			const id = `hobo-${next}`;
			asking.getStore()?.add(id);
			const answer = new Promise<JsonValue | undefined>((resolve) => {
				// Unanswered past the deadline: withdrawn, as a cancel would.
				const deadline = setTimeout(() => {
					if (!waiting.has(id)) return;
					waiting.delete(id);
					write({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: {
							requestId: id,
							reason: `No answer within ${formDeadlineMs < 60_000 ? `${Math.ceil(formDeadlineMs / 1000)} second${formDeadlineMs <= 1000 ? "" : "s"}` : `${Math.round(formDeadlineMs / 60_000)} minutes`}.`,
						},
					});
					resolve(undefined);
				}, formDeadlineMs);
				deadline.unref();
				waiting.set(id, (value) => {
					clearTimeout(deadline);
					resolve(value);
				});
			});
			write({ jsonrpc: "2.0", id, method, params });
			return answer;
		};
	/** The client cancelled one of its requests: withdraw what it asked for. */
	const cancelled = (requestId: string) => {
		for (const id of askedFor.get(requestId) ?? []) {
			const resolve = waiting.get(id);
			if (resolve === undefined) continue;
			waiting.delete(id);
			write({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: {
					requestId: id,
					reason: "The tool call that asked for it was cancelled.",
				},
			});
			resolve(undefined);
		}
		askedFor.delete(requestId);
	};
	const inFlight = new Set<Promise<void>>();
	let buffer = "";
	for await (const chunk of options.input) {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (line.length === 0) continue;
			let parsed: JsonValue | undefined;
			try {
				parsed = JSON.parse(line);
			} catch {
				parsed = undefined;
			}
			// The client's answer to one of this server's requests.
			if (
				isJsonObject(parsed) &&
				parsed.method === undefined &&
				isJsonString(parsed.id) &&
				waiting.has(parsed.id)
			) {
				const resolve = waiting.get(parsed.id);
				waiting.delete(parsed.id);
				resolve?.(parsed.error !== undefined ? undefined : parsed.result);
				continue;
			}
			// A response to nothing open (a form withdrawn at its deadline or
			// by a cancel, answered late): dropped. It is never handled as a
			// request, which would send the host a reply to a reply.
			if (
				isJsonObject(parsed) &&
				parsed.method === undefined &&
				(parsed.result !== undefined || parsed.error !== undefined)
			)
				continue;
			if (isJsonObject(parsed) && parsed.method === "notifications/cancelled") {
				const target = isJsonObject(parsed.params)
					? parsed.params.requestId
					: undefined;
				const requestId = REQUEST_ID.safeParse(target);
				if (requestId.success) cancelled(requestId.data);
				continue;
			}
			const own = new Set<string>();
			const parsedId = REQUEST_ID.safeParse(
				isJsonObject(parsed) ? parsed.id : undefined,
			);
			const incoming = parsedId.success ? parsedId.data : undefined;
			if (incoming !== undefined) askedFor.set(incoming, own);
			const handled = asking
				.run(own, () =>
					handleMcpMessage(options.server, options.auth, line, options.session),
				)
				.then((response) => {
					if (response !== null) write(response);
				})
				.finally(() => {
					if (incoming !== undefined) askedFor.delete(incoming);
				});
			inFlight.add(handled);
			void handled.finally(() => inFlight.delete(handled));
		}
	}
	// Input ended: an elicitation still open will never be answered.
	for (const resolve of waiting.values()) resolve(undefined);
	await Promise.all(inFlight);
}
