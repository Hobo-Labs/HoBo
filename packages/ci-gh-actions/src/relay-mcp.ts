import { randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ControlAuthenticator } from "./control-auth.js";
import { reportRelayFailure } from "./failure-log.js";
import type { HostedRelay } from "./hosted-relay.js";
import {
	createRelayMcpServer,
	RELAY_MCP_EVENTS_URI,
	RELAY_MCP_LEASES_URI,
	type RelayMcpServices,
	type RelayMcpStore,
	relayMcpLeaseUri,
} from "./relay-mcp-server.js";

/**
 * How a host keeps MCP sessions. `memory`: a long-lived process holds each
 * session, its stream and its resource subscriptions, and pushes updates.
 * `none`: every request stands alone and is answered with JSON, for a host
 * whose process does not outlive the request.
 */
export type RelayMcpSessions = "memory" | "none";

export type RelayMcpOptions = Readonly<{
	store: RelayMcpStore;
	/** The relay over the current configuration, for a reconciliation. */
	relay: () => Promise<Pick<HostedRelay, "reconcile">>;
	/** The account API's authenticator: the same bearer credentials and scopes. */
	authenticate: ControlAuthenticator;
	/** The relay's readiness, as `/readyz` reports it. */
	ready: () => Promise<boolean>;
	/** The relay's public origin: the only `Origin` a browser may send. */
	publicOrigin: string;
	sessions: RelayMcpSessions;
	engineId?: string;
	/** Sessions held at once, in all and for one account. */
	maxSessions?: number;
	maxSessionsPerAccount?: number;
	/** A session with no open stream is closed after this long without a request. */
	sessionIdleMs?: number;
	/** How long `wait_for_events` blocks when the caller names no timeout, and at most. */
	waitDefaultMs?: number;
	waitMaxMs?: number;
	/** `wait_for_events` calls blocked at once. */
	maxWaits?: number;
	/** How often a wait or the subscription pump reads the journal. */
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}>;

/** The MCP endpoint a host mounts, and the shutdown that ends its sessions. */
export type RelayMcp = Readonly<{
	handle(request: Request): Promise<Response>;
	/** Close every session and stream and stop the subscription pump. */
	close(): Promise<void>;
}>;

const MAX_BODY = 1024 * 1024;
const MAX_SUBSCRIPTIONS = 100;
const PUMP_PAGE = 500;

/** Whether a request path is the MCP endpoint, at the root or under an engine mount. */
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

/** JSON answers are never cached; an event stream keeps the headers it was given. */
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

/** The request body, or undefined once it passes the relay's 1 MiB limit. */
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

function bounded(value: number | undefined, fallback: number, name: string) {
	const chosen = value ?? fallback;
	if (!Number.isInteger(chosen) || chosen < 1)
		throw new Error(`invalid MCP ${name}`);
	return chosen;
}

/** One held session: its server and transport, whose it is, and what it follows. */
type Session = {
	readonly accountId: string;
	readonly server: McpServer;
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly subscriptions: Set<string>;
	id: string | undefined;
	lastSeenAt: number;
	/** Event streams the client holds open; a listening session is not idle. */
	streams: number;
};

/** Pass a stream through, and say once when the client or the server ends it. */
function tracked(
	body: ReadableStream<Uint8Array>,
	ended: () => void,
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
			} else controller.enqueue(chunk.value);
		},
		async cancel(reason) {
			end();
			await reader.cancel(reason);
		},
	});
}

/**
 * The relay as an MCP server over Streamable HTTP, for whichever host serves
 * it. Tools and resources read one account's leases, queued jobs and journal;
 * `wait_for_events` is the change feed on every host, and a host that keeps
 * sessions also pushes `notifications/resources/updated` to subscribers.
 */
export function createRelayMcp(options: RelayMcpOptions): RelayMcp {
	const origin = new URL(options.publicOrigin).origin;
	const maxSessions = bounded(options.maxSessions, 64, "session limit");
	const maxSessionsPerAccount = bounded(
		options.maxSessionsPerAccount,
		16,
		"account session limit",
	);
	const sessionIdleMs = bounded(
		options.sessionIdleMs,
		15 * 60_000,
		"session idle time",
	);
	const maxWaits = bounded(options.maxWaits, 32, "wait limit");
	const waitMaxMs = bounded(options.waitMaxMs, 50_000, "wait ceiling");
	const waitDefaultMs = Math.min(
		waitMaxMs,
		bounded(options.waitDefaultMs, 25_000, "wait default"),
	);
	const pollMs = bounded(options.pollMs, 1_000, "poll interval");
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const closing = new AbortController();
	const sessions = new Map<string, Session>();
	/** Where each subscribed account's journal has been read up to. */
	const cursors = new Map<string, number>();
	let opening = 0;
	let waits = 0;
	let pump: Promise<void> | undefined;

	const shared = {
		store: options.store,
		relay: options.relay,
		ready: options.ready,
		engineId: options.engineId ?? "gh-actions",
		waitDefaultMs,
		waitMaxMs,
		pollMs,
		beginWait: () => {
			if (waits >= maxWaits) return false;
			waits++;
			return true;
		},
		endWait: () => {
			waits--;
		},
		now,
		sleep,
	} satisfies RelayMcpServices;

	function subscribers(accountId: string): Session[] {
		return [...sessions.values()].filter(
			(session) =>
				session.accountId === accountId && session.subscriptions.size > 0,
		);
	}

	/** Read each subscribed account's journal once and tell its sessions what changed. */
	async function pumpOnce(): Promise<void> {
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
				// The next pass reads from the same position; nothing is lost.
				reportRelayFailure(
					"hobo_ci_mcp_pump_failed",
					{},
					error instanceof Error ? error : undefined,
				);
			}
		}
	}

	/** One pump for the process, and only while somebody is subscribed. */
	function ensurePump(): void {
		if (pump || closing.signal.aborted) return;
		pump = (async () => {
			while (!closing.signal.aborted && cursors.size > 0) {
				await closeIdle();
				await pumpOnce();
				if (cursors.size === 0) break;
				await sleep(pollMs, closing.signal);
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
				// A subscription that arrived as the loop was ending starts the next one.
				if (cursors.size > 0) ensurePump();
			});
	}

	async function endSession(session: Session): Promise<void> {
		if (session.id !== undefined && sessions.get(session.id) === session)
			sessions.delete(session.id);
		session.subscriptions.clear();
		await session.server.close().catch(() => undefined);
	}

	async function closeIdle(): Promise<void> {
		const cutoff = now() - sessionIdleMs;
		for (const session of sessions.values())
			if (session.streams === 0 && session.lastSeenAt <= cutoff)
				await endSession(session);
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
					// Follow the journal from now: a subscriber reads the resource
					// for what came before.
					if (!cursors.has(account)) {
						const head = await options.store.eventsSince({
							accountId: account,
							limit: 1,
						});
						if (!cursors.has(account)) cursors.set(account, head.cursor);
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
		};
		// However the session ends (a DELETE, a close, the host draining), it
		// leaves the registry and stops being notified.
		transport.onclose = () => {
			if (session.id !== undefined && sessions.get(session.id) === session)
				sessions.delete(session.id);
			subscriptions.clear();
		};
		await server.connect(transport);
		return session;
	}

	/** One request of a session: its stream, when it opens one, is counted. */
	async function inSession(
		session: Session,
		request: Request,
		authInfo: AuthInfo,
	): Promise<Response> {
		session.lastSeenAt = now();
		const response = await session.transport.handleRequest(request, {
			authInfo,
		});
		if (
			!response.body ||
			!response.headers.get("content-type")?.startsWith("text/event-stream")
		)
			return response;
		session.streams++;
		return new Response(
			tracked(response.body, () => {
				session.streams--;
				session.lastSeenAt = now();
			}),
			{ status: response.status, headers: response.headers },
		);
	}

	async function withSessions(
		request: Request,
		accountId: string,
		authInfo: AuthInfo,
	): Promise<Response> {
		await closeIdle();
		const id = request.headers.get("mcp-session-id");
		if (id !== null) {
			const session = sessions.get(id);
			// Another account's session is as absent as one that never existed.
			if (!session || session.accountId !== accountId)
				return refuse(404, "session not found");
			return inSession(session, request, authInfo);
		}
		if (request.method !== "POST")
			return refuse(400, "MCP session required; initialize first");
		if (
			sessions.size + opening >= maxSessions ||
			[...sessions.values()].filter(
				(session) => session.accountId === accountId,
			).length >= maxSessionsPerAccount
		)
			return refuse(429, "too many MCP sessions; close one or retry later", {
				"Retry-After": "30",
			});
		opening++;
		try {
			const session = await openSession(accountId);
			const response = await inSession(session, request, authInfo);
			// Only an initialize request opens a session; anything else was refused.
			if (session.id === undefined) await endSession(session);
			return response;
		} finally {
			opening--;
		}
	}

	/** A request that stands alone: a fresh server, a JSON answer, nothing kept. */
	async function standalone(
		request: Request,
		authInfo: AuthInfo,
	): Promise<Response> {
		const server = createRelayMcpServer(shared);
		const transport = new WebStandardStreamableHTTPServerTransport({
			enableJsonResponse: true,
		});
		await server.connect(transport);
		let abandon = (): void => undefined;
		try {
			return await Promise.race([
				transport.handleRequest(request, { authInfo }),
				// A caller that hung up gets no answer; stop working on one.
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
			// A browser names its page's origin on a cross-origin request; only
			// the relay's own may ask, so a page elsewhere cannot drive a local relay.
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
			// The credential has done its work; no tool or resource is handed it.
			const headers = new Headers(request.headers);
			headers.delete("authorization");
			const init: RequestInit = {
				method: request.method,
				headers,
				signal: request.signal,
			};
			if (request.method === "POST") {
				const body = await boundedBody(request).catch(() => undefined);
				if (!body) return refuse(413, "request body too large");
				init.body = body;
			}
			const framed = new Request(request.url, init);
			// The transport hands this to every tool and resource of the request.
			const authInfo: AuthInfo = {
				token: "",
				clientId: principal.accountId,
				scopes: [...principal.scopes],
				extra: { requestSignal: request.signal },
			};
			return noStore(
				stateless
					? await standalone(framed, authInfo)
					: await withSessions(framed, principal.accountId, authInfo),
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
