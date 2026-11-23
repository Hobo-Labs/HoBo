import { randomUUID } from "node:crypto";
import { create, toJsonString } from "@bufbuild/protobuf";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
	CallToolResult,
	ElicitRequestFormParams,
	ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	RelayMcpSetupResultSchema,
	type RelayMcpSetupStatus,
	RelayMcpSetupStatusSchema,
} from "./_generated/relay_mcp_pb.js";
import { reportRelayFailure } from "./failure-log.js";

// public-contract: the setup-mode MCP tool an owner's client calls for the relay's gaps.
export const RELAY_SETUP_STATUS_TOOL = "relay_setup_status";
// public-contract: the setup-mode MCP tool that shows the owner the configuration form.
export const RELAY_SETUP_PROVIDE_TOOL = "relay_setup_provide";
// public-contract: the setup form's field for the store writer's client ID.
export const RELAY_SETUP_WRITER_CLIENT_ID = "writerClientId";
// public-contract: the setup form's field for the store writer's one-use client secret.
export const RELAY_SETUP_WRITER_CLIENT_SECRET = "writerClientSecret";

export type RelaySetupState =
	| "configured"
	| "not-configured"
	| "config-service-denied"
	| "config-service-unavailable"
	| "start-failed";

export type RelaySetupGaps = Readonly<{
	state: RelaySetupState;
	missing: readonly string[];
	invalid: readonly string[];
}>;

export type RelaySetupEntry = Readonly<{
	name: string;
	title: string;
	description: string;
}>;

export type RelaySetupWriterCredential = Readonly<{
	clientId: string;
	clientSecret: string;
}>;

export type RelaySetupWriteRefusal =
	| "writer-refused"
	| "store-unavailable"
	| "store-not-writable";

export class RelaySetupWriteError extends Error {
	readonly code: RelaySetupWriteRefusal;
	constructor(code: RelaySetupWriteRefusal) {
		super(`relay setup write failed (${code})`);
		this.name = "RelaySetupWriteError";
		this.code = code;
	}
}

export type RelaySetupWriter = (
	credential: RelaySetupWriterCredential,
	entries: ReadonlyMap<string, string>,
) => Promise<void>;

export type RelaySetupMcpOptions = Readonly<{
	publicOrigin: string;
	gaps: () => Promise<RelaySetupGaps>;
	entries: readonly RelaySetupEntry[];
	accept: (name: string, value: string) => string | undefined;
	write: RelaySetupWriter | undefined;
	formTimeoutMs?: number;
	maxSessions?: number;
	sessionIdleMs?: number;
	now?: () => number;
}>;

export type RelaySetupMcp = Readonly<{
	handle(request: Request): Promise<Response>;
	close(): Promise<void>;
}>;

const MAX_BODY = 1024 * 1024;
const ENTRY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ProvideInput = {
	names: z.array(z.string().regex(ENTRY_NAME)).max(64).optional(),
};
const FormContent = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
const FormText = z.string();
const Json = z.json();
type JsonMessage = z.infer<typeof Json>;
type PostedBody =
	| Readonly<{ kind: "json"; message: JsonMessage }>
	| Readonly<{ kind: "too-large" }>
	| Readonly<{ kind: "not-json" }>;

const INSTRUCTIONS =
	"This HoBo CI relay is in setup mode: its config service does not yet hold a complete configuration, so CI traffic is refused. relay_setup_status names what is missing or invalid (names only). relay_setup_provide shows the owner a form for those entries together with a one-use client secret of the store's hobo-secret-writer identity; the relay writes what the owner enters straight to its config service. Never ask for any value in chat and never repeat one.";

function refuse(status: number, error: string): Response {
	return Response.json(
		{ error },
		{ status, headers: { "Cache-Control": "no-store" } },
	);
}

function view(text: string): CallToolResult {
	return {
		content: [{ type: "text", text }],
		structuredContent: z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(text)),
	};
}

function setupStatus(message: RelayMcpSetupStatus): CallToolResult {
	return view(
		toJsonString(RelayMcpSetupStatusSchema, message, {
			alwaysEmitImplicit: true,
		}),
	);
}

function setupResult(
	outcome: string,
	lists: Readonly<{
		written?: readonly string[];
		refused?: readonly string[];
		remaining?: readonly string[];
	}> = {},
): CallToolResult {
	const message = create(RelayMcpSetupResultSchema, {
		outcome,
		written: [...(lists.written ?? [])],
		refused: [...(lists.refused ?? [])],
		remaining: [...(lists.remaining ?? [])],
	});
	return view(
		toJsonString(RelayMcpSetupResultSchema, message, {
			alwaysEmitImplicit: true,
		}),
	);
}

function outstanding(gaps: RelaySetupGaps): readonly string[] {
	return [...new Set([...gaps.missing, ...gaps.invalid])].sort();
}

export function relaySetupForm(
	entries: readonly RelaySetupEntry[],
): ElicitRequestFormParams {
	const properties: ElicitRequestFormParams["requestedSchema"]["properties"] = {
		[RELAY_SETUP_WRITER_CLIENT_ID]: {
			type: "string",
			title: "hobo-secret-writer client ID",
			description:
				"The Universal Auth client ID of the store's hobo-secret-writer identity.",
			minLength: 1,
			maxLength: 256,
		},
		[RELAY_SETUP_WRITER_CLIENT_SECRET]: {
			type: "string",
			title: "One-use client secret of hobo-secret-writer",
			description:
				"Create a client secret limited to one use and a few minutes; the relay spends it on this write and keeps nothing.",
			minLength: 16,
			maxLength: 512,
		},
	};
	for (const entry of entries)
		properties[entry.name] = {
			type: "string",
			title: entry.title,
			description: entry.description,
			maxLength: 32_768,
		};
	return {
		mode: "form",
		message:
			"Enter the relay's missing configuration. Each value goes from this form to the relay's config service and is never shown to the assistant. Leave an entry empty to skip it.",
		requestedSchema: {
			type: "object",
			properties,
			required: [
				RELAY_SETUP_WRITER_CLIENT_ID,
				RELAY_SETUP_WRITER_CLIENT_SECRET,
			],
		},
	};
}

type Session = {
	readonly server: McpServer;
	readonly transport: WebStandardStreamableHTTPServerTransport;
	lastSeenAt: number;
};

export function createRelaySetupMcp(
	options: RelaySetupMcpOptions,
): RelaySetupMcp {
	const origin = new URL(options.publicOrigin).origin;
	const now = options.now ?? Date.now;
	const maxSessions = options.maxSessions ?? 16;
	const sessionIdleMs = options.sessionIdleMs ?? 15 * 60_000;
	const formTimeoutMs = options.formTimeoutMs ?? 240_000;
	const catalog = new Map(options.entries.map((entry) => [entry.name, entry]));
	const sessions = new Map<string, Session>();

	async function status(): Promise<CallToolResult> {
		const gaps = await options.gaps();
		const open = outstanding(gaps);
		return setupStatus(
			create(RelayMcpSetupStatusSchema, {
				state: gaps.state,
				missing: [...gaps.missing].sort(),
				invalid: [...gaps.invalid].sort(),
				providable: open.filter((name) => catalog.has(name)),
				writable: options.write !== undefined,
			}),
		);
	}

	async function provide(
		server: McpServer,
		names: readonly string[] | undefined,
		requestId: string | number,
	): Promise<CallToolResult> {
		const gaps = await options.gaps();
		const open = outstanding(gaps);
		const asked = open.filter(
			(name) =>
				catalog.has(name) && (names === undefined || names.includes(name)),
		);
		if (asked.length === 0)
			return setupResult("nothing-to-provide", { remaining: open });
		const write = options.write;
		if (write === undefined)
			return setupResult("store-not-writable", { remaining: open });
		if (server.server.getClientCapabilities()?.elicitation === undefined)
			return setupResult("form-unavailable", { remaining: open });
		const asking = asked.flatMap((name) => {
			const entry = catalog.get(name);
			return entry === undefined ? [] : [entry];
		});
		let answer: ElicitResult;
		try {
			answer = await server.server.elicitInput(relaySetupForm(asking), {
				relatedRequestId: requestId,
				timeout: formTimeoutMs,
			});
		} catch {
			return setupResult("form-unavailable", { remaining: open });
		}
		if (answer.action === "decline")
			return setupResult("declined", { remaining: open });
		if (answer.action !== "accept")
			return setupResult("cancelled", { remaining: open });
		const content = FormContent.safeParse(answer.content ?? {});
		if (!content.success)
			return setupResult("nothing-valid", { remaining: open });
		const text = (name: string) => {
			const field = FormText.safeParse(content.data[name]);
			return field.success && field.data.trim() !== "" ? field.data : undefined;
		};
		const clientId = text(RELAY_SETUP_WRITER_CLIENT_ID);
		const clientSecret = text(RELAY_SETUP_WRITER_CLIENT_SECRET);
		const accepted = new Map<string, string>();
		const refused: string[] = [];
		for (const name of asked) {
			const value = text(name);
			if (value === undefined) continue;
			const parsed = options.accept(name, value);
			if (parsed === undefined) refused.push(name);
			else accepted.set(name, parsed);
		}
		if (
			clientId === undefined ||
			clientSecret === undefined ||
			accepted.size === 0
		)
			return setupResult("nothing-valid", { refused, remaining: open });
		try {
			await write({ clientId, clientSecret }, accepted);
		} catch (error) {
			const code =
				error instanceof RelaySetupWriteError
					? error.code
					: "store-unavailable";
			reportRelayFailure(
				"hobo_ci_relay_setup_write_failed",
				{ code, entries: accepted.size },
				undefined,
			);
			return setupResult(code, { refused, remaining: open });
		}
		const written = [...accepted.keys()].sort();
		return setupResult("written", {
			written,
			refused,
			remaining: open.filter((name) => !accepted.has(name)),
		});
	}

	function createServer(): McpServer {
		const server = new McpServer(
			{ name: "hobo-ci-relay-setup", version: "1.0.0" },
			{ capabilities: { tools: {} }, instructions: INSTRUCTIONS },
		);
		server.registerTool(
			RELAY_SETUP_STATUS_TOOL,
			{
				title: "Relay setup status",
				description:
					"Why the relay has not started and which config-service entries are missing or invalid, by name only.",
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			() => status(),
		);
		server.registerTool(
			RELAY_SETUP_PROVIDE_TOOL,
			{
				title: "Provide relay configuration",
				description:
					"Show the owner a form for the missing or invalid entries (optionally only `names`). The relay writes what the owner enters to its config service with a one-use hobo-secret-writer credential from the same form. Returns entry names only.",
				inputSchema: ProvideInput,
				annotations: { destructiveHint: false, openWorldHint: true },
			},
			(input, extra) => provide(server, input.names, extra.requestId),
		);
		return server;
	}

	function sweep(): void {
		const cutoff = now() - sessionIdleMs;
		for (const [id, session] of sessions)
			if (session.lastSeenAt < cutoff) {
				sessions.delete(id);
				session.transport.close().catch(() => undefined);
			}
	}

	async function open(): Promise<Session | undefined> {
		sweep();
		if (sessions.size >= maxSessions) {
			let oldest: [string, Session] | undefined;
			for (const entry of sessions)
				if (oldest === undefined || entry[1].lastSeenAt < oldest[1].lastSeenAt)
					oldest = entry;
			if (oldest === undefined) return undefined;
			sessions.delete(oldest[0]);
			await oldest[1].transport.close().catch(() => undefined);
		}
		const server = createServer();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			onsessioninitialized: (id) => {
				sessions.set(id, session);
			},
		});
		const session: Session = { server, transport, lastSeenAt: now() };
		await server.connect(transport);
		return session;
	}

	async function body(request: Request): Promise<PostedBody> {
		const declared = request.headers.get("content-length");
		if (
			declared !== null &&
			(!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY)
		)
			return { kind: "too-large" };
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.byteLength > MAX_BODY) return { kind: "too-large" };
		try {
			const text = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes);
			return { kind: "json", message: Json.parse(JSON.parse(text)) };
		} catch {
			return { kind: "not-json" };
		}
	}

	return {
		async handle(request) {
			const offered = request.headers.get("origin");
			if (offered !== null && offered !== origin)
				return refuse(403, "origin not allowed");
			const id = request.headers.get("mcp-session-id");
			let parsedBody: JsonMessage | undefined;
			if (request.method === "POST") {
				const posted = await body(request);
				if (posted.kind === "too-large")
					return refuse(413, "request body too large");
				if (posted.kind === "not-json")
					return refuse(400, "request body is not JSON");
				parsedBody = posted.message;
			}
			let session: Session | undefined;
			if (id !== null) {
				sweep();
				session = sessions.get(id);
				if (session === undefined)
					return Response.json(
						{
							jsonrpc: "2.0",
							error: { code: -32001, message: "Session not found" },
							id: null,
						},
						{ status: 404, headers: { "Cache-Control": "no-store" } },
					);
				session.lastSeenAt = now();
			} else {
				if (request.method !== "POST")
					return refuse(400, "an MCP session is required");
				session = await open();
				if (session === undefined) return refuse(503, "setup sessions full");
			}
			return session.transport.handleRequest(request, { parsedBody });
		},
		async close() {
			const held = [...sessions.values()];
			sessions.clear();
			await Promise.all(
				held.map((session) => session.transport.close().catch(() => undefined)),
			);
		},
	};
}
