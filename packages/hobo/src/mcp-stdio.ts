import { AsyncLocalStorage } from "node:async_hooks";
import { parseArgv, parseLifecycleArgs } from "@hobo/cli";
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
import { parseCiArgs } from "./ci-command.js";
import {
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

export {
	HOBO_MCP_PROTOCOL_VERSION,
	HOBO_MCP_SERVER_NAME,
	HOBO_MCP_SERVER_VERSION,
} from "./mcp-handshake.js";

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

// The per-connection state of the secret-capture MCP App (ADR-0179
// amendment "Deploy secrets captured by an MCP App into the secret store"):
// the app, and what the client said it supports at `initialize` (MCP Apps,
// URL-mode elicitation). Absent, the server is the CLI verb surface only.
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

const OWNER_SETUP_CODES = new Set([
	"HOBO_OK",
	"HOBO_UP_INCOMPLETE",
	"HOBO_UP_FAILED",
	"HOBO_UP_NO_BINDLE",
	"HOBO_CLI_USAGE",
	"HOBO_CI_APP_NEEDS_OWNER",
	"HOBO_CI_SETTINGS_NEEDED",
	"HOBO_CI_GITHUB_OWNER_UNKNOWN",
	"HOBO_CI_MANAGED_PREVIEW",
	"HOBO_CI_UP_VERCEL_NOT_CONNECTED",
	"HOBO_CD_VERCEL_AWAITING_APPROVAL",
	"HOBO_CD_VERCEL_DEVICE_DENIED",
	"HOBO_CD_VERCEL_DEVICE_EXPIRED",
	"HOBO_CD_VERCEL_DEVICE_FAILED",
	"HOBO_CD_JOURNAL_NOT_PROVISIONED",
	"HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE",
	"HOBO_CD_PREPARED_PLACEMENT_UNAVAILABLE",
	"MCP_SCOPE_DENIED",
	"MCP_RATE_LIMITED",
	...["CI", "CD"].flatMap((family) =>
		[
			"STORE_CHOICE",
			"STORE_NEEDS_SIGN_IN",
			"STORE_UNAVAILABLE",
			"STORE_OPERATION_UNCERTAIN",
			"SECRET_STORE_INVALID",
			"SECRET_STORE_UNAVAILABLE",
			"OWNER_CHOICE_CHANGED",
			"INFISICAL_SIGN_IN",
			"INFISICAL_CLI_INSTALL",
			"INFISICAL_EGRESS",
			"INFISICAL_API",
			"ONEPASSWORD_SIGN_IN",
			"ONEPASSWORD_CLI_INSTALL",
			"ONEPASSWORD_SERVICE_ACCOUNT",
			"ONEPASSWORD_PRIVATE_PROCESS_UNAVAILABLE",
			"BITWARDEN_ORGANIZATION",
			"BITWARDEN_APPROVAL_REQUIRED",
			"BITWARDEN_NEEDS_API_KEY",
			"BITWARDEN_API",
			"BITWARDEN_API_KEY_REJECTED",
			"BITWARDEN_DENIED",
			"BITWARDEN_NOT_APPROVED",
			"BITWARDEN_ACCOUNT",
		].map((suffix) => `HOBO_${family}_${suffix}`),
	),
]);

const OWNER_SETUP_STATUSES = new Set([
	"ok",
	"ready",
	"up",
	"waiting",
	"needs-connection",
	"unavailable",
	"refused",
	"error",
	"usage",
	"usage_error",
	"deployed",
	"rejected",
	"denied",
	"throttled",
]);

const OWNER_STEP_CODES = new Set([
	"HOBO_CI_APP_NEEDS_OWNER",
	"HOBO_CI_SETTINGS_NEEDED",
	"HOBO_CD_VERCEL_AWAITING_APPROVAL",
	"HOBO_CD_VERCEL_DEVICE_EXPIRED",
	...["CI", "CD"].flatMap((family) =>
		[
			"STORE_CHOICE",
			"STORE_NEEDS_SIGN_IN",
			"INFISICAL_SIGN_IN",
			"ONEPASSWORD_SIGN_IN",
			"BITWARDEN_ORGANIZATION",
			"BITWARDEN_APPROVAL_REQUIRED",
			"BITWARDEN_NEEDS_API_KEY",
		].map((suffix) => `HOBO_${family}_${suffix}`),
	),
]);

function ownerSetupResponse(
	result: {
		readonly ok: boolean;
		readonly code: string;
		readonly status: string;
		readonly output: unknown;
	},
	formAvailable: boolean,
	ci: boolean,
) {
	const completed =
		result.ok &&
		isJsonObject(result.output) &&
		result.output.ok === true &&
		((result.output.status === "deployed" &&
			result.output.code === "HOBO_OK") ||
			(ci &&
				result.output.status === "ok" &&
				result.output.code === "HOBO_CI_MANAGED_PREVIEW"));
	if (result.ok && !completed)
		return {
			ok: false,
			status: "incomplete",
			code: "HOBO_MCP_SETUP_NOT_COMPLETED",
			action: "run-setup",
			message: "HoBo did not report a completed deployment.",
		};
	const missingForm =
		!result.ok && !formAvailable && OWNER_STEP_CODES.has(result.code);
	const unavailableApproval =
		!result.ok &&
		(result.code === "HOBO_CI_HANDOFF_SILENT" ||
			result.code === "HOBO_CD_HANDOFF_SILENT");
	const code = unavailableApproval
		? "HOBO_MCP_OWNER_APPROVAL_UNAVAILABLE"
		: missingForm
			? "HOBO_MCP_OWNER_FORM_UNAVAILABLE"
			: OWNER_SETUP_CODES.has(result.code)
				? result.code
				: "HOBO_MCP_SETUP_RESULT";
	return {
		ok: result.ok,
		status:
			missingForm || unavailableApproval
				? "unavailable"
				: OWNER_SETUP_STATUSES.has(result.status)
					? result.status
					: "unknown",
		code,
		action: result.ok
			? "none"
			: unavailableApproval
				? "secure-owner-approval-required"
				: missingForm
					? "secure-owner-form-required"
					: code === "HOBO_CI_UP_VERCEL_NOT_CONNECTED"
						? "run-cd-setup"
						: code === "HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE"
							? "atomic-claim-store-required"
							: code === "HOBO_CD_VERCEL_DEVICE_DENIED"
								? "wait-for-owner-request"
								: code.endsWith("_STORE_OPERATION_UNCERTAIN")
									? "reconcile-store-operation"
									: code.endsWith("_ONEPASSWORD_PRIVATE_PROCESS_UNAVAILABLE")
										? "private-owner-session-required"
										: code === "MCP_SCOPE_DENIED"
											? "authorization-required"
											: code === "MCP_RATE_LIMITED"
												? "retry-after-throttle"
												: code.endsWith("_STORE_CHOICE")
													? "choose-secret-store"
													: "retry-setup-when-ready",
		message: unavailableApproval
			? "This owner approval cannot be completed privately in this HoBo session."
			: missingForm
				? "This host cannot provide the secure HoBo owner hand-off."
				: code === "HOBO_CI_UP_VERCEL_NOT_CONNECTED"
					? "Run the HoBo CD setup ceremony before retrying CI."
					: code === "HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE"
						? "A verified atomic claim store or an existing complete CD journal fleet is required."
						: code === "HOBO_CD_VERCEL_DEVICE_DENIED"
							? "The owner declined Vercel approval. Retry only if they request it."
							: code.endsWith("_STORE_OPERATION_UNCERTAIN")
								? "A store operation may have completed; reconcile it before retrying."
								: code.endsWith("_ONEPASSWORD_PRIVATE_PROCESS_UNAVAILABLE")
									? "This HoBo session cannot provision that connection privately."
									: code === "HOBO_CD_VERCEL_DEVICE_EXPIRED"
										? "Run again to request a new Vercel approval."
										: !result.ok && OWNER_STEP_CODES.has(result.code)
											? "Run again when the owner is ready."
											: "HoBo returned a setup status. Owner steps use the secure form.",
	};
}

function ownerSetupRefusal(
	id: number | string | null,
	code: string,
	message: string,
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		result: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						ok: false,
						status: "unavailable",
						code,
						message,
					}),
				},
			],
			isError: true,
		},
	};
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
			if (session !== undefined) {
				// What this host declared, for diagnosing what it can show the
				// owner (capabilities only: nothing secret is in them).
				process.stderr.write(
					`hobo-mcp: client capabilities ${JSON.stringify(request.params?.capabilities ?? null)}\n`,
				);
				session.support = negotiateSecretCaptureSupport(
					request.params?.capabilities,
				);
				session.storeSupport = negotiateStoreChoiceSupport(
					request.params?.capabilities,
				);
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
			const uri = request.params?.uri;
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
			const commandArgs = Array.isArray(args.args)
				? args.args.filter((a): a is string => isJsonString(a))
				: [];
			const family = params.name === "ci" || params.name === "cd";
			let familyArgs: readonly string[] = [];
			let help = false;
			if (family) {
				try {
					const parsed = parseArgv([
						params.name,
						"--json",
						...(isJsonString(args.camp) ? ["--camp", args.camp] : []),
						...commandArgs,
					]);
					familyArgs = parsed.args;
					help = parsed.help;
				} catch {
					return ownerSetupRefusal(
						id,
						"HOBO_MCP_INPUT_INVALID",
						"HoBo could not parse the command arguments.",
					);
				}
			}
			const action = familyArgs[0];
			const ownerUp = family && action === "up";
			let fallbackAction = action;
			if (
				params.name === "ci" &&
				action !== "up" &&
				action !== "down" &&
				action !== "plan" &&
				action !== "status"
			) {
				try {
					fallbackAction = parseCiArgs(familyArgs).positionals[0];
				} catch {
					fallbackAction = action;
				}
			}
			if (
				params.name === "ci" &&
				(action === "app" ||
					action === "secret-store" ||
					fallbackAction === "app" ||
					fallbackAction === "secret-store")
			)
				return ownerSetupRefusal(
					id,
					"HOBO_MCP_LEGACY_SETUP_BLOCKED",
					"Use hobo ci up --hand-off through the secure owner channel.",
				);
			if (ownerUp && help)
				return ownerSetupRefusal(
					id,
					"HOBO_MCP_SETUP_HELP",
					"Help does not run the setup ceremony.",
				);
			if (ownerUp) {
				const lifecycle = parseLifecycleArgs(familyArgs.slice(1));
				if (!lifecycle.ok)
					return ownerSetupRefusal(
						id,
						"HOBO_MCP_INPUT_INVALID",
						"HoBo could not parse the setup options.",
					);
				if (!lifecycle.flags.handOff)
					return ownerSetupRefusal(
						id,
						"HOBO_MCP_HANDOFF_REQUIRED",
						"Run setup with --hand-off through the secure owner channel.",
					);
			}
			const formAvailable =
				session?.support.formElicitation === true &&
				session.request !== undefined;
			let result: Awaited<ReturnType<HoboMcpServer["callTool"]>>;
			try {
				result = await server.callTool(
					params.name,
					{
						...(isJsonString(args.cwd) ? { cwd: args.cwd } : undefined),
						...(isJsonString(args.camp) ? { camp: args.camp } : undefined),
						...(Array.isArray(args.args)
							? {
									args: commandArgs,
								}
							: undefined),
					},
					auth,
				);
			} catch (error) {
				if (ownerUp)
					return ownerSetupRefusal(
						id,
						"HOBO_MCP_SETUP_FAILED",
						"HoBo could not complete setup.",
					);
				throw error;
			}
			const safe = ownerUp
				? ownerSetupResponse(result, formAvailable, params.name === "ci")
				: undefined;
			return {
				jsonrpc: "2.0",
				id,
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								safe ?? result.output ?? result.error ?? null,
							),
						},
					],
					isError: safe === undefined ? !result.ok : !safe.ok,
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

/** A JSON-RPC request id (a string or a number), as the map key we keep. */
const REQUEST_ID = z.union([z.string(), z.number()]).transform(String);

// Serve newline-delimited JSON-RPC over the given streams until input ends.
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
