import { randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ControlAuthenticator } from "./control-auth.js";
import { reportRelayFailure } from "./failure-log.js";
import type { HostedRelay } from "./hosted-relay.js";
import type { MeshNodesReader } from "./mesh-nodes-reader.js";
import { createCursorCodecs } from "./relay-mcp-cursor.js";
import {
	createRelayMcpServer,
	RELAY_MCP_EVENTS_URI,
	RELAY_MCP_LEASES_URI,
	type RelayMcpServices,
	type RelayMcpStore,
	relayMcpLeaseUri,
} from "./relay-mcp-server.js";

export type RelayMcpSessions = "memory" | "none";

export type RelayMcpOptions = Readonly<{
	store: RelayMcpStore;
	relay: () => Promise<Pick<HostedRelay, "reconcile">>;
	authenticate: ControlAuthenticator;
	ready: () => Promise<boolean>;
	meshNodes?: MeshNodesReader | undefined;
	publicOrigin: string;
	sessions: RelayMcpSessions;
	cursorSecret: string;
	engineId?: string;
	maxSessions?: number;
	maxSessionsPerAccount?: number;
	sessionIdleMs?: number;
	streamMaxMs?: number;
	displaceCooldownMs?: number;
	waitDefaultMs?: number;
	waitMaxMs?: number;
	maxWaits?: number;
	maxWaitsPerAccount?: number;
	maxCallsPerAccount?: number;
	maxRequestMessages?: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	pause?: () => Promise<void>;
}>;

export type RelayMcp = Readonly<{
	handle(request: Request): Promise<Response>;
	close(): Promise<void>;
}>;

const MAX_BODY = 1024 * 1024;
const MAX_SUBSCRIPTIONS = 100;
const PUMP_PAGE = 500;
const PUMP_BACKOFF_MAX_MS = 60_000;
const Json = z.json();
const Batch = z.array(z.unknown());
const Initialize = z.object({ method: z.literal("initialize") });

export function isRelayMcpPath(pathname: string): boolean {
	return /^(?:\/engines\/[a-z0-9-]{1,40})?\/mcp$/.test(pathname);
}

function refuse(
	status: number,
	error: string,
	headers: Readonly<Record<string, string>> = {},
): Response {
	return Response.json(
		{ error },
		{ status, headers: { "Cache-Control": "no-store", ...headers } },
	);
}

function noStore(response: Response): Response {
	if (response.headers.get("content-type")?.startsWith("text/event-stream"))
		return response;
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function boundedBody(request: Request) {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)
	)
		return undefined;
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > MAX_BODY) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(chunk.value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

type Posted = Readonly<{
	message: z.infer<typeof Json>;
	messages: number;
	opensSession: boolean;
}>;

function parsePosted(
	body: Uint8Array,
	maxMessages: number,
): Posted | undefined {
	try {
		const parsed: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
		);
		const batch = Batch.safeParse(parsed);
		if (batch.success && batch.data.length > maxMessages)
			return {
				message: null,
				messages: batch.data.length,
				opensSession: false,
			};
		const message = Json.safeParse(parsed);
		if (!message.success) return undefined;
		return {
			message: message.data,
			messages: batch.success ? batch.data.length : 1,
			opensSession: Initialize.safeParse(message.data).success,
		};
	} catch {
		return undefined;
	}
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

function shares(perAccount: number, overall: number) {
	const held = new Map<string, number>();
	let total = 0;
	return {
		take(accountId: string): boolean {
			const mine = held.get(accountId) ?? 0;
			if (mine >= perAccount || total >= overall) return false;
			held.set(accountId, mine + 1);
			total += 1;
			return true;
		},
		release(accountId: string): void {
			const mine = held.get(accountId) ?? 0;
			if (mine === 0) return;
			if (mine === 1) held.delete(accountId);
			else held.set(accountId, mine - 1);
			total -= 1;
		},
		held: (accountId: string): number => held.get(accountId) ?? 0,
	};
}

function bounded(value: number | undefined, fallback: number, name: string) {
	const chosen = value ?? fallback;
	if (!Number.isInteger(chosen) || chosen < 1)
		throw new Error(`invalid MCP ${name}`);
	return chosen;
}

type Session = {
	readonly accountId: string;
	readonly server: McpServer;
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly subscriptions: Set<string>;
	id: string | undefined;
	lastSeenAt: number;
	streams: number;
	listeningSince: number | undefined;
};

function tracked(
	body: ReadableStream<Uint8Array>,
	ended: () => void,
	afterChunk: () => void,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let open = true;
	const end = () => {
		if (open) ended();
		open = false;
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const chunk = await reader.read();
			if (chunk.done) {
				end();
				controller.close();
				return;
			}
			controller.enqueue(chunk.value);
			afterChunk();
		},
		async cancel(reason) {
			end();
			await reader.cancel(reason);
		},
	});
}

export function createRelayMcp(options: RelayMcpOptions): RelayMcp {
	const origin = new URL(options.publicOrigin).origin;
	const maxSessions = bounded(options.maxSessions, 64, "session limit");
	const maxSessionsPerAccount = bounded(
		options.maxSessionsPerAccount,
		8,
		"account session limit",
	);
	const sessionIdleMs = bounded(
		options.sessionIdleMs,
		15 * 60_000,
		"session idle time",
	);
	const streamMaxMs = bounded(
		options.streamMaxMs,
		30 * 60_000,
		"stream lifetime",
	);
	const waitMaxMs = bounded(options.waitMaxMs, 50_000, "wait ceiling");
	const waitDefaultMs = Math.min(
		waitMaxMs,
		bounded(options.waitDefaultMs, 25_000, "wait default"),
	);
	const displaceCooldownMs = bounded(
		options.displaceCooldownMs,
		60_000,
		"displacement cool-down",
	);
	const maxWaitsPerAccount = bounded(
		options.maxWaitsPerAccount,
		maxSessionsPerAccount,
		"account wait limit",
	);
	const maxCallsPerAccount = bounded(
		options.maxCallsPerAccount,
		8,
		"account call limit",
	);
	const maxRequestMessages = bounded(
		options.maxRequestMessages,
		8,
		"request message limit",
	);
	const waits = shares(
		maxWaitsPerAccount,
		bounded(options.maxWaits, maxSessions, "wait limit"),
	);
	const calls = shares(maxCallsPerAccount, Number.POSITIVE_INFINITY);
	const pollMs = bounded(options.pollMs, 1_000, "poll interval");
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const closing = new AbortController();
	const sessions = new Map<string, Session>();
	const opening = shares(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	let openingTurn: Promise<void> = Promise.resolve();
	const displacedAt = new Map<string, number>();
	const cursors = new Map<string, number>();
	let pump: Promise<void> | undefined;

	const shared = {
		store: options.store,
		relay: options.relay,
		ready: options.ready,
		meshNodes: options.meshNodes,
		engineId: options.engineId ?? "gh-actions",
		waitDefaultMs,
		waitMaxMs,
		pollMs,
		cursors: createCursorCodecs(options.cursorSecret),
		beginCall: calls.take,
		endCall: calls.release,
		beginWait: waits.take,
		endWait: waits.release,
		accountCalls: maxCallsPerAccount,
		accountWaits: maxWaitsPerAccount,
		requestMessages: maxRequestMessages,
		now,
		sleep,
		pause: options.pause ?? nextTurn,
	} satisfies RelayMcpServices;

	function subscribers(accountId: string): Session[] {
		return [...sessions.values()].filter(
			(session) =>
				session.accountId === accountId && session.subscriptions.size > 0,
		);
	}

	async function pumpOnce(): Promise<boolean> {
		for (const [accountId, after] of cursors) {
			const listening = subscribers(accountId);
			if (listening.length === 0) {
				cursors.delete(accountId);
				continue;
			}
			try {
				const page = await options.store.eventsSince({
					accountId,
					after,
					limit: PUMP_PAGE,
				});
				if (cursors.has(accountId)) cursors.set(accountId, page.cursor);
				const changed = new Set<string>();
				for (const { event } of page.events) {
					changed.add(RELAY_MCP_EVENTS_URI);
					if (event?.leaseId) {
						changed.add(RELAY_MCP_LEASES_URI);
						changed.add(relayMcpLeaseUri(event.leaseId));
					}
				}
				for (const session of listening)
					for (const uri of session.subscriptions)
						if (changed.has(uri))
							await session.server.server
								.sendResourceUpdated({ uri })
								.catch(() => undefined);
			} catch (error) {
				reportRelayFailure(
					"hobo_ci_mcp_pump_failed",
					{},
					error instanceof Error ? error : undefined,
				);
				return false;
			}
		}
		return true;
	}

	function ensurePump(): void {
		if (pump || closing.signal.aborted) return;
		pump = (async () => {
			let failures = 0;
			while (!closing.signal.aborted && cursors.size > 0) {
				await sweep();
				failures = (await pumpOnce()) ? 0 : failures + 1;
				if (cursors.size === 0) break;
				await sleep(
					Math.min(pollMs * 2 ** failures, PUMP_BACKOFF_MAX_MS),
					closing.signal,
				);
			}
		})()
			.catch((error) => {
				reportRelayFailure(
					"hobo_ci_mcp_pump_failed",
					{},
					error instanceof Error ? error : undefined,
				);
			})
			.finally(() => {
				pump = undefined;
				if (cursors.size > 0) ensurePump();
			});
	}

	async function endSession(session: Session): Promise<void> {
		if (session.id !== undefined && sessions.get(session.id) === session)
			sessions.delete(session.id);
		session.subscriptions.clear();
		await session.server.close().catch(() => undefined);
	}

	async function sweep(): Promise<void> {
		const at = now();
		for (const session of sessions.values()) {
			if (
				session.listeningSince !== undefined &&
				at - session.listeningSince >= streamMaxMs
			)
				session.transport.closeStandaloneSSEStream();
			if (session.streams === 0 && session.lastSeenAt <= at - sessionIdleMs)
				await endSession(session);
		}
		for (const [accountId, displaced] of displacedAt)
			if (at - displaced >= displaceCooldownMs) displacedAt.delete(accountId);
	}

	function sessionsOf(accountId: string): number {
		let held = opening.held(accountId);
		for (const session of sessions.values())
			if (session.accountId === accountId) held += 1;
		return held;
	}

	function overShare(accountId: string): Session | undefined {
		const held = new Map<string, Session[]>();
		for (const session of sessions.values())
			held.set(session.accountId, [
				...(held.get(session.accountId) ?? []),
				session,
			]);
		const mine = held.get(accountId)?.length ?? 0;
		const fair = Math.max(
			1,
			Math.floor(maxSessions / (held.size + (mine === 0 ? 1 : 0))),
		);
		if (mine >= fair) return undefined;
		const [largest] = [...held.entries()]
			.filter(
				([holder, theirs]) => holder !== accountId && theirs.length > fair,
			)
			.sort((a, b) => b[1].length - a[1].length);
		return largest?.[1].sort(
			(a, b) => a.streams - b.streams || a.lastSeenAt - b.lastSeenAt,
		)[0];
	}

	async function openSession(accountId: string): Promise<Session> {
		const subscriptions = new Set<string>();
		const server = createRelayMcpServer({
			...shared,
			subscriptions: {
				async subscribe(account, uri) {
					if (
						!subscriptions.has(uri) &&
						subscriptions.size >= MAX_SUBSCRIPTIONS
					)
						throw new Error("too many subscriptions");
					if (!cursors.has(account)) {
						const head = await options.store.journalHead();
						if (!cursors.has(account)) cursors.set(account, head);
					}
					subscriptions.add(uri);
					ensurePump();
				},
				unsubscribe(uri) {
					subscriptions.delete(uri);
				},
			},
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			onsessioninitialized: (id) => {
				session.id = id;
				sessions.set(id, session);
			},
		});
		const session: Session = {
			accountId,
			server,
			transport,
			subscriptions,
			id: undefined,
			lastSeenAt: now(),
			streams: 0,
			listeningSince: undefined,
		};
		transport.onclose = () => {
			if (session.id !== undefined && sessions.get(session.id) === session)
				sessions.delete(session.id);
			subscriptions.clear();
		};
		await server.connect(transport);
		return session;
	}

	async function inSession(
		session: Session,
		request: Request,
		authInfo: AuthInfo,
		posted: Posted | undefined,
	): Promise<Response> {
		session.lastSeenAt = now();
		const response = await session.transport.handleRequest(request, {
			authInfo,
			parsedBody: posted?.message,
		});
		if (
			!response.body ||
			!response.headers.get("content-type")?.startsWith("text/event-stream")
		)
			return response;
		session.streams++;
		const listening = request.method === "GET";
		if (listening) session.listeningSince = now();
		return new Response(
			tracked(
				response.body,
				() => {
					session.streams--;
					session.lastSeenAt = now();
					if (listening) session.listeningSince = undefined;
				},
				() => {
					if (
						listening &&
						session.listeningSince !== undefined &&
						now() - session.listeningSince >= streamMaxMs
					)
						session.transport.closeStandaloneSSEStream();
				},
			),
			{ status: response.status, headers: response.headers },
		);
	}

	async function withSessions(
		request: Request,
		accountId: string,
		authInfo: AuthInfo,
		posted: Posted | undefined,
	): Promise<Response> {
		await sweep();
		const id = request.headers.get("mcp-session-id");
		if (id !== null) {
			const session = sessions.get(id);
			if (!session || session.accountId !== accountId)
				return refuse(404, "session not found");
			return inSession(session, request, authInfo, posted);
		}
		if (!posted?.opensSession)
			return refuse(400, "MCP session required; initialize first");
		const crowded = () =>
			refuse(429, "too many MCP sessions; close one or retry later", {
				"Retry-After": "30",
			});
		if (sessionsOf(accountId) >= maxSessionsPerAccount) return crowded();
		opening.take(accountId);
		const opened = openingTurn.then(async () => {
			const giving =
				sessions.size >= maxSessions ? overShare(accountId) : undefined;
			const displaced = displacedAt.get(accountId);
			if (
				sessions.size >= maxSessions &&
				(!giving ||
					(displaced !== undefined && now() - displaced < displaceCooldownMs))
			)
				return crowded();
			const session = await openSession(accountId);
			const response = await inSession(session, request, authInfo, posted);
			if (session.id === undefined) {
				await endSession(session);
				return response;
			}
			if (giving?.id !== undefined && sessions.get(giving.id) === giving) {
				displacedAt.set(accountId, now());
				await endSession(giving);
			}
			return response;
		});
		openingTurn = opened.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await opened;
		} finally {
			opening.release(accountId);
		}
	}

	async function standalone(
		request: Request,
		authInfo: AuthInfo,
		posted: Posted | undefined,
	): Promise<Response> {
		const server = createRelayMcpServer(shared);
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		await server.connect(transport);
		let abandon = (): void => undefined;
		try {
			return await Promise.race([
				transport.handleRequest(request, {
					authInfo,
					parsedBody: posted?.message,
				}),
				new Promise<Response>((resolve) => {
					abandon = () => resolve(refuse(400, "request abandoned"));
					request.signal.addEventListener("abort", abandon, { once: true });
					closing.signal.addEventListener("abort", abandon, { once: true });
				}),
			]);
		} finally {
			request.signal.removeEventListener("abort", abandon);
			closing.signal.removeEventListener("abort", abandon);
			await server.close().catch(() => undefined);
		}
	}

	return {
		async handle(request) {
			const requestOrigin = request.headers.get("origin");
			if (requestOrigin !== null && requestOrigin !== origin)
				return refuse(403, "origin not allowed");
			if (closing.signal.aborted) return refuse(503, "service unavailable");
			const principal = await options.authenticate(
				request.headers.get("authorization") ?? undefined,
			);
			if (!principal)
				return refuse(401, "account authentication required", {
					"WWW-Authenticate": "Bearer",
				});
			if (
				!principal.scopes.includes("policy:read") &&
				!principal.scopes.includes("operations:write")
			)
				return refuse(403, "account scope required");
			const stateless = options.sessions === "none";
			const allowed = stateless ? ["POST"] : ["GET", "POST", "DELETE"];
			if (!allowed.includes(request.method))
				return refuse(405, "method not allowed", {
					Allow: allowed.join(", "),
				});
			let posted: Posted | undefined;
			if (request.method === "POST") {
				const body = await boundedBody(request).catch(() => undefined);
				if (!body) return refuse(413, "request body too large");
				posted = parsePosted(body, maxRequestMessages);
				if (!posted) return refuse(400, "request body is not JSON");
				if (posted.messages > maxRequestMessages)
					return refuse(
						400,
						`too many JSON-RPC messages in one request; at most ${maxRequestMessages}`,
					);
			}
			const headers = new Headers(request.headers);
			headers.delete("authorization");
			const framed = new Request(request.url, {
				method: request.method,
				headers,
				signal: request.signal,
			});
			const authInfo: AuthInfo = {
				token: "",
				clientId: principal.accountId,
				scopes: [...principal.scopes],
				extra: { requestSignal: request.signal },
			};
			return noStore(
				stateless
					? await standalone(framed, authInfo, posted)
					: await withSessions(framed, principal.accountId, authInfo, posted),
			);
		},
		async close() {
			closing.abort();
			await Promise.all([...sessions.values()].map(endSession));
			cursors.clear();
			await pump;
		},
	};
}
