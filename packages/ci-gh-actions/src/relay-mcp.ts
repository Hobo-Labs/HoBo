import { randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ControlAuthenticator } from "./control-auth.js";
import { reportRelayFailure } from "./failure-log.js";
import type { HostedRelay } from "./hosted-relay.js";
import { createCursorCodecs } from "./relay-mcp-cursor.js";
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
	/**
	 * A secret every instance of this host shares. The cursors callers hold are
	 * journal positions enciphered under per-account keys derived from it; it
	 * is never used as a key itself. Changing it invalidates issued cursors.
	 */
	cursorSecret: string;
	engineId?: string;
	/** Sessions held at once, in all and for one account. */
	maxSessions?: number;
	maxSessionsPerAccount?: number;
	/** A session with no open stream is closed after this long without a request. */
	sessionIdleMs?: number;
	/** A session's event stream is closed after this long; its client opens another. */
	streamMaxMs?: number;
	/**
	 * How long `wait_for_events` blocks when the caller names no timeout, and
	 * at most. The host names the ceiling: it must fit inside whatever limits
	 * how long that host may hold one request.
	 */
	waitDefaultMs?: number;
	waitMaxMs?: number;
	/** `wait_for_events` calls blocked at once, in all and for one account. */
	maxWaits?: number;
	maxWaitsPerAccount?: number;
	/** Tools and resource reads one account may have in progress at once. */
	maxCallsPerAccount?: number;
	/** JSON-RPC messages one HTTP request may carry. */
	maxRequestMessages?: number;
	/** How often a wait or the subscription pump reads the journal. */
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Hands the event loop back; resolves on a later turn. */
	pause?: () => Promise<void>;
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
/** The longest the subscription pump waits between tries while the store fails. */
const PUMP_BACKOFF_MAX_MS = 60_000;
const Batch = z.array(z.unknown());

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

/** How many JSON-RPC messages a body carries; one unless it is a batch. */
function messageCount(body: Uint8Array): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body).toString("utf8"));
	} catch {
		// Not JSON: the transport answers that.
		return 1;
	}
	const batch = Batch.safeParse(parsed);
	return batch.success ? batch.data.length : 1;
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

/** A real turn of the event loop: timers, sockets and signals run before it resolves. */
function nextTurn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * What each account has in progress, held to its own share and to a ceiling
 * for everyone. An account that has taken its share is refused while the
 * others still have theirs.
 */
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
	/** When the session's own event stream (its GET) was opened, while it is open. */
	listeningSince: number | undefined;
};

/**
 * Pass a stream through, and say once when the client or the server ends it.
 * `afterChunk` runs as each chunk goes by: a stream that outlives its time is
 * noticed at its next keep-alive at the latest.
 */
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
	const maxWaitsPerAccount = bounded(
		options.maxWaitsPerAccount,
		4,
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
		bounded(options.maxWaits, 32, "wait limit"),
	);
	const calls = shares(maxCallsPerAccount, Number.POSITIVE_INFINITY);
	const pollMs = bounded(options.pollMs, 1_000, "poll interval");
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const closing = new AbortController();
	const sessions = new Map<string, Session>();
	/** Sessions each account is in the middle of opening. */
	const opening = shares(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	let openingTotal = 0;
	/** Where each subscribed account's journal has been read up to. */
	const cursors = new Map<string, number>();
	let pump: Promise<void> | undefined;

	const shared = {
		store: options.store,
		relay: options.relay,
		ready: options.ready,
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

	/**
	 * Read each subscribed account's journal once and tell its sessions what
	 * changed. False when the store failed: the pass stops there, since the
	 * next account would fail the same way, and nothing is lost because every
	 * cursor stays where it was.
	 */
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
				// One line however many accounts are subscribed; the failure log
				// itself writes at most one per window.
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

	/** One pump for the process, and only while somebody is subscribed. */
	function ensurePump(): void {
		if (pump || closing.signal.aborted) return;
		pump = (async () => {
			let failures = 0;
			while (!closing.signal.aborted && cursors.size > 0) {
				await sweep();
				failures = (await pumpOnce()) ? 0 : failures + 1;
				if (cursors.size === 0) break;
				// A store that is down is asked again less and less often.
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

	/**
	 * End what has outstayed its time: an event stream past its lifetime is
	 * closed for its client to open another, and a session that holds no
	 * stream and has made no request for the idle time is closed.
	 */
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
	}

	/** How many sessions an account holds or is opening. */
	function sessionsOf(accountId: string): number {
		let held = opening.held(accountId);
		for (const session of sessions.values())
			if (session.accountId === accountId) held += 1;
		return held;
	}

	/**
	 * With every place taken, free one for an account that holds less than
	 * its fair share: the least recently used session of whichever account
	 * holds the most, when that is at least two more than the caller held
	 * before this request. No account can keep another out by filling the
	 * host; the account that loses a session opens it again.
	 */
	async function makeRoom(accountId: string): Promise<boolean> {
		const held = new Map<string, Session[]>();
		for (const session of sessions.values())
			held.set(session.accountId, [
				...(held.get(session.accountId) ?? []),
				session,
			]);
		const largest = [...held.values()].sort((a, b) => b.length - a.length)[0];
		// `sessionsOf` already counts the session this request is opening.
		if (!largest || largest.length <= sessionsOf(accountId)) return false;
		const [victim] = largest.sort(
			(a, b) => a.streams - b.streams || a.lastSeenAt - b.lastSeenAt,
		);
		if (!victim) return false;
		await endSession(victim);
		return true;
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
		// The session's own stream is the one a client can hold open for ever.
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
	): Promise<Response> {
		await sweep();
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
		const crowded = () =>
			refuse(429, "too many MCP sessions; close one or retry later", {
				"Retry-After": "30",
			});
		// The account's own share counts the sessions it is still opening.
		if (sessionsOf(accountId) >= maxSessionsPerAccount) return crowded();
		// Taken before anything is awaited, so two requests cannot both take
		// the last place.
		opening.take(accountId);
		openingTotal += 1;
		try {
			if (
				sessions.size + openingTotal > maxSessions &&
				!(await makeRoom(accountId))
			)
				return crowded();
			const session = await openSession(accountId);
			const response = await inSession(session, request, authInfo);
			// Only an initialize request opens a session; anything else was refused.
			if (session.id === undefined) await endSession(session);
			return response;
		} finally {
			opening.release(accountId);
			openingTotal -= 1;
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
				// One request is a bounded amount of work: the transport runs
				// every message of a batch at once.
				if (messageCount(body) > maxRequestMessages)
					return refuse(
						400,
						`too many JSON-RPC messages in one request; at most ${maxRequestMessages}`,
					);
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
