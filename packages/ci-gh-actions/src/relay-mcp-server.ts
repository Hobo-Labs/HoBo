import { create, type DescMessage, toJsonString } from "@bufbuild/protobuf";
import {
	accountOwnsJob,
	type CiObserver,
	type Lease,
	type SequencedCiEvent,
} from "@hobo/ci";
import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
	type CallToolResult,
	ErrorCode,
	McpError,
	type ReadResourceResult,
	type ServerNotification,
	type ServerRequest,
	SubscribeRequestSchema,
	UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
	type RelayMcpEvent,
	RelayMcpEventsSchema,
	RelayMcpJobsSchema,
	RelayMcpLeaseDetailSchema,
	RelayMcpLeaseSchema,
	RelayMcpLeasesSchema,
	RelayMcpQuarantineSchema,
	RelayMcpRetrySchema,
	RelayMcpStatusSchema,
} from "./_generated/relay_mcp_pb.js";
import {
	type AccountOperationsStore,
	accountLease,
	ControlError,
	configurationState,
	quarantinedDeliveries,
	reconcileAccountLease,
	retryQuarantinedDelivery,
} from "./account-operations.js";
import { reportRelayFailure } from "./failure-log.js";
import type { HostedRelay } from "./hosted-relay.js";
import { CURSOR_START, type CursorCodec } from "./relay-mcp-cursor.js";
import {
	eventView,
	jobView,
	leaseView,
	quarantinedDeliveryView,
} from "./relay-mcp-views.js";

// public-contract: the MCP resource URI of an account's leases.
export const RELAY_MCP_LEASES_URI = "hobo-ci://leases";
// public-contract: the MCP resource URI of an account's recent events.
export const RELAY_MCP_EVENTS_URI = "hobo-ci://events";
// public-contract: the MCP resource URI template of one lease.
export const RELAY_MCP_LEASE_URI_TEMPLATE = "hobo-ci://leases/{leaseId}";

const LEASE_ID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LEASE_URI = /^hobo-ci:\/\/leases\/([a-f0-9-]{36})$/;
/** How many of the account's events one read looks through for the ones a caller asked for. */
const EVENT_WINDOW = 500;
/**
 * How many reads in a row one `wait_for_events` call makes while it is still
 * behind the end of the journal. Past that it hands the cursor back and says
 * there is more, so that no call works without end.
 */
const WAIT_CATCH_UP_READS = 8;
/** How many of a lease's latest events `get_lease` returns. */
const LEASE_EVENTS = 20;
const READ_SCOPE = "policy:read";
const WRITE_SCOPE = "operations:write";

/** The MCP resource URI of one lease. */
export function relayMcpLeaseUri(leaseId: string): string {
	return `${RELAY_MCP_LEASES_URI}/${leaseId}`;
}

/** Whether a URI names a resource this server can report changes to. */
export function isRelayMcpResource(uri: string): boolean {
	return (
		uri === RELAY_MCP_LEASES_URI ||
		uri === RELAY_MCP_EVENTS_URI ||
		LEASE_ID.test(LEASE_URI.exec(uri)?.[1] ?? "")
	);
}

/**
 * What the MCP server reads and the one thing it writes itself. The reads are
 * an observer's: they take no partition lock, so nothing an agent asks is
 * queued in front of webhook admission.
 */
export type RelayMcpStore = CiObserver &
	Pick<AccountOperationsStore, "retryQuarantinedWebhook">;

/** What a tool or resource is given by the host that serves it. */
export type RelayMcpServices = Readonly<{
	store: RelayMcpStore;
	/** The relay over the current configuration, for a reconciliation. */
	relay: () => Promise<Pick<HostedRelay, "reconcile">>;
	ready: () => Promise<boolean>;
	engineId: string;
	waitDefaultMs: number;
	waitMaxMs: number;
	pollMs: number;
	/** The cursors of one account: a journal position as the caller holds it. */
	cursors: (accountId: string) => CursorCodec;
	/**
	 * Take one of the account's places for a tool or resource in progress;
	 * false when the account already holds all of them.
	 */
	beginCall: (accountId: string) => boolean;
	endCall: (accountId: string) => void;
	/** Admit one more blocked `wait_for_events`: the account's share, then the host's. */
	beginWait: (accountId: string) => boolean;
	endWait: (accountId: string) => void;
	/** The limits above, as `get_relay_status` reports them. */
	accountCalls: number;
	accountWaits: number;
	requestMessages: number;
	now: () => number;
	/** Resolves after `ms`, or as soon as the signal aborts. */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Hands the event loop back: resolves on a later turn, not in this one. */
	pause: () => Promise<void>;
	/** Present on a host that keeps sessions: resource subscriptions for one session. */
	subscriptions?: Readonly<{
		subscribe(accountId: string, uri: string): Promise<void>;
		unsubscribe(uri: string): void;
	}>;
}>;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Who a request acts as, and the signal that ends its work early. */
type Caller = Readonly<{
	accountId: string;
	scopes: readonly string[];
	signal: AbortSignal;
}>;

/**
 * The caller the HTTP layer authenticated for this request. It arrives as the
 * transport's auth info: the account as its client, the credential's scopes,
 * and the HTTP request's own abort signal beside the protocol's.
 */
function callerOf(extra: Extra): Caller {
	const auth = extra.authInfo;
	if (!auth?.clientId)
		throw new ControlError(401, "account authentication required");
	const request = auth.extra?.requestSignal;
	return {
		accountId: auth.clientId,
		scopes: auth.scopes,
		signal:
			request instanceof AbortSignal
				? AbortSignal.any([extra.signal, request])
				: extra.signal,
	};
}

const Structured = z.record(z.string(), z.unknown());

/** The generated message a schema describes. */
type ViewOf<Desc extends DescMessage> = Parameters<
	typeof toJsonString<Desc>
>[1];

/** A tool result: the view as protobuf JSON, as text and as structured content. */
function result<Desc extends DescMessage>(
	schema: Desc,
	message: ViewOf<Desc>,
): CallToolResult {
	// Zero and empty fields are written out: a caller reads `timedOut: false`
	// and an empty `events` list, not their absence.
	const text = toJsonString(schema, message, { alwaysEmitImplicit: true });
	return {
		content: [{ type: "text", text }],
		structuredContent: Structured.parse(JSON.parse(text)),
	};
}

function resource<Desc extends DescMessage>(
	uri: URL,
	schema: Desc,
	message: ViewOf<Desc>,
): ReadResourceResult {
	return {
		contents: [
			{
				uri: uri.href,
				mimeType: "application/json",
				text: toJsonString(schema, message, { alwaysEmitImplicit: true }),
			},
		],
	};
}

function refusal(message: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text: message }] };
}

const UNCONFIRMED =
	"relay operation could not be confirmed; retry or inspect its state";

const BUSY =
	"too many calls in progress for this account; retry when one has finished";

/**
 * Run one tool or resource read for a caller holding `scope`, inside the
 * account's share of what may run at once. However many calls one request or
 * one account sends, only that many touch the store together.
 */
async function forCaller<Answer>(
	services: RelayMcpServices,
	scope: string,
	caller: Caller,
	run: (caller: Caller) => Promise<Answer>,
): Promise<Answer> {
	if (!caller.scopes.includes(scope))
		throw new ControlError(403, `account scope required: ${scope}`);
	if (!services.beginCall(caller.accountId)) throw new ControlError(429, BUSY);
	try {
		return await run(caller);
	} finally {
		services.endCall(caller.accountId);
	}
}

/** Run a tool; a refusal is a tool error, not a thrown one. */
async function asTool(
	services: RelayMcpServices,
	name: string,
	scope: string,
	extra: Extra,
	run: (caller: Caller) => Promise<CallToolResult>,
): Promise<CallToolResult> {
	let caller: Caller | undefined;
	try {
		caller = callerOf(extra);
		return await forCaller(services, scope, caller, run);
	} catch (error) {
		if (error instanceof ControlError) return refusal(error.message);
		// The caller went away; there is nobody to answer.
		if (caller?.signal.aborted) throw error;
		reportRelayFailure(
			"hobo_ci_mcp_tool_failed",
			{ tool: name },
			error instanceof Error ? error : undefined,
		);
		return refusal(UNCONFIRMED);
	}
}

/** Read a resource for a caller holding the read scope. */
async function asResource(
	services: RelayMcpServices,
	extra: Extra,
	read: (caller: Caller) => Promise<ReadResourceResult>,
): Promise<ReadResourceResult> {
	try {
		return await forCaller(services, READ_SCOPE, callerOf(extra), read);
	} catch (error) {
		if (error instanceof ControlError)
			throw new McpError(
				error.status === 404
					? ErrorCode.InvalidParams
					: ErrorCode.InvalidRequest,
				error.message,
			);
		reportRelayFailure(
			"hobo_ci_mcp_resource_failed",
			{},
			error instanceof Error ? error : undefined,
		);
		throw new McpError(ErrorCode.InternalError, UNCONFIRMED);
	}
}

/** Which events a caller asked for, beyond their being the account's. */
type EventFilter = Readonly<{
	leaseId?: string | undefined;
	repository?: string | undefined;
	types?: readonly string[] | undefined;
}>;

function matches(event: RelayMcpEvent, filter: EventFilter): boolean {
	return (
		(filter.leaseId === undefined || event.leaseId === filter.leaseId) &&
		(filter.repository === undefined ||
			event.repository.toLowerCase() === filter.repository.toLowerCase()) &&
		(filter.types === undefined ||
			filter.types.length === 0 ||
			filter.types.includes(event.type))
	);
}

/** What one read of the account's journal found, and where the next one starts. */
type EventRead = Readonly<{
	events: RelayMcpEvent[];
	/** The journal position to read after next. */
	position: number;
	/** The read stopped before the end of the journal. */
	more: boolean;
	/** A read of the newest events left older ones unread. */
	truncated: boolean;
}>;

/** The position a caller's cursor stands for; a cursor not issued to it is refused. */
function positionOf(codec: CursorCodec, cursor: string): number {
	const position = codec.decode(cursor);
	if (position === undefined)
		throw new ControlError(
			400,
			`invalid cursor: pass the cursor of an earlier result, or "${CURSOR_START}" to read from the start`,
		);
	return position;
}

/**
 * One read of the account's journal: the matching events after `after`, or
 * the newest matching ones without it.
 */
async function readEvents(
	services: RelayMcpServices,
	accountId: string,
	after: number | undefined,
	filter: EventFilter,
	limit: number,
): Promise<EventRead> {
	const codec = services.cursors(accountId);
	const page = await services.store.eventsSince(
		after === undefined
			? { accountId, limit: EVENT_WINDOW }
			: { accountId, after, limit: EVENT_WINDOW },
	);
	const found = page.events
		.map((entry: SequencedCiEvent) => ({
			position: entry.seq,
			view: eventView(entry, codec),
		}))
		.filter((entry) => matches(entry.view, filter));
	if (after === undefined)
		return {
			events: found.slice(-limit).map((entry) => entry.view),
			position: page.cursor,
			more: false,
			// Older events went unread when the store stopped looking back, or
			// when a full window held fewer matches than were asked for.
			truncated:
				page.truncated ||
				(page.events.length === EVENT_WINDOW && found.length < limit),
		};
	// More matched than fit: resume after the last one returned, not after
	// the ones left behind.
	const last = found.length > limit ? found[limit - 1] : undefined;
	return {
		events: found.slice(0, limit).map((entry) => entry.view),
		position: last ? last.position : page.cursor,
		more: last !== undefined || page.more,
		truncated: false,
	};
}

/** A read as the caller receives it: the views, and the cursor to continue from. */
function eventsResult(
	services: RelayMcpServices,
	accountId: string,
	read: EventRead,
	timedOut: boolean,
): CallToolResult {
	return result(
		RelayMcpEventsSchema,
		create(RelayMcpEventsSchema, {
			events: read.events,
			cursor: services.cursors(accountId).encode(read.position),
			timedOut,
			more: read.more,
			truncated: read.truncated,
		}),
	);
}

/**
 * Hold the request until the account's journal has a matching event after
 * the cursor, or the timeout passes. The journal is polled here, once, so
 * that no client has to poll the relay.
 *
 * Every pass begins by handing the event loop back, so a store that answers
 * in the same turn cannot keep webhooks, health checks, the worker or this
 * caller's own cancellation waiting while the wait catches up. A pass reads
 * one bounded span of the journal, and a call that is still behind after
 * `WAIT_CATCH_UP_READS` of them returns the cursor with `more` set.
 */
async function waitForEvents(
	services: RelayMcpServices,
	caller: Caller,
	wait: Readonly<{
		after: number | undefined;
		timeoutMs: number;
		filter: EventFilter;
		limit: number;
	}>,
): Promise<CallToolResult> {
	const { store, now, sleep, pollMs, pause } = services;
	const { accountId, signal } = caller;
	const deadline = now() + wait.timeoutMs;
	// Without a cursor the wait starts now: only what happens next counts.
	let after = wait.after ?? (await store.journalHead());
	let behind = 0;
	for (;;) {
		await pause();
		signal.throwIfAborted();
		const read = await readEvents(
			services,
			accountId,
			after,
			wait.filter,
			wait.limit,
		);
		if (read.events.length > 0)
			return eventsResult(services, accountId, read, false);
		after = read.position;
		const remaining = deadline - now();
		if (read.more) {
			// Not at the end of the journal yet, so not a timeout either: read
			// on, within this call's share of work and time.
			behind += 1;
			if (behind >= WAIT_CATCH_UP_READS || remaining <= 0)
				return eventsResult(services, accountId, read, false);
			continue;
		}
		if (remaining <= 0) return eventsResult(services, accountId, read, true);
		await sleep(Math.min(pollMs, remaining), signal);
	}
}

/** Newest first: a lease's creation time, then its id for a stable order. */
function newestFirst(
	a: Pick<Lease, "createdAt" | "id">,
	b: Pick<Lease, "createdAt" | "id">,
): number {
	return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

async function leaseDetail(
	services: RelayMcpServices,
	accountId: string,
	leaseId: string,
) {
	const lease = await accountLease(services.store, accountId, leaseId);
	const codec = services.cursors(accountId);
	// By the lease's id, so they are found whatever else the journal holds.
	const events = await services.store.leaseEvents({
		accountId,
		leaseId: lease.id,
		limit: LEASE_EVENTS,
	});
	return create(RelayMcpLeaseDetailSchema, {
		lease: leaseView(lease),
		events: events.map((entry) => eventView(entry, codec)),
	});
}

// The pattern admits what a cursor can look like; whether it is one this
// relay issued to this account is decided when it is deciphered.
const Cursor = z
	.string()
	.regex(/^(0|[A-Za-z0-9_-]{22})$/)
	.describe(
		`Where to read from: the \`cursor\` of an earlier result, or "${CURSOR_START}" for the start of the account's journal. Opaque; only this account's cursors work.`,
	);
const LeaseId = z.string().regex(LEASE_ID).describe("The lease's id (a UUID).");
const Repository = z
	.string()
	.min(1)
	.max(200)
	.describe("A repository as owner/name; case is ignored.");
const EventTypes = z
	.array(z.string().regex(/^ci\.[A-Za-z]{1,60}$/))
	.max(32)
	.describe(
		"Only these event types, for example ci.JobQueued, ci.LeaseReserved, ci.RunnerClaimed, ci.HostSettled, ci.LeaseUncertain, ci.LeaseCancelled, ci.LeaseExpired, ci.JobExpired, ci.JobCompleted.",
	);

const INSTRUCTIONS = [
	"The HoBo CI relay: leases (a runner reserved for one GitHub Actions job), queued jobs and the journal of every change to them, for the authenticated account only.",
	"To follow job state without polling, call wait_for_events with the cursor of your last result; it returns as soon as something changes, or with timedOut true. Start from list_events or list_leases.",
	"On a host that keeps sessions (get_relay_status reports subscriptions: true) you can instead subscribe to hobo-ci://events, hobo-ci://leases or hobo-ci://leases/{leaseId} and read the resource when notified.",
].join(" ");

/**
 * The relay's MCP server for one transport: the tools and resources over an
 * account's leases, queued jobs and journal. It holds no state of its own;
 * every call reads the store as the caller the HTTP layer authenticated.
 */
export function createRelayMcpServer(services: RelayMcpServices): McpServer {
	const { store } = services;
	const server = new McpServer(
		{ name: "hobo-ci-relay", version: "1.0.0" },
		{
			instructions: INSTRUCTIONS,
			capabilities: services.subscriptions
				? { resources: { subscribe: true } }
				: {},
		},
	);
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool(
		"list_leases",
		{
			title: "List leases",
			description:
				"The account's leases, newest first. A lease is a runner reserved for one job; its state moves reserved, dispatching, dispatched, claiming, running, then completed, cancelled or expired (uncertain needs reconciliation).",
			inputSchema: {
				state: z
					.string()
					.min(1)
					.max(40)
					.optional()
					.describe("Only this state."),
				repository: Repository.optional(),
				runId: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Only leases of this workflow run."),
				activeOnly: z
					.boolean()
					.optional()
					.describe("Only leases that still hold capacity."),
				limit: z.number().int().min(1).max(200).optional(),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, "list_leases", READ_SCOPE, extra, async (caller) => {
				const limit = input.limit ?? 50;
				const repository = input.repository?.toLowerCase();
				const found = (await store.accountLeases(caller.accountId))
					.map(leaseView)
					.filter(
						(lease) =>
							(input.state === undefined || lease.state === input.state) &&
							(repository === undefined ||
								lease.repository.toLowerCase() === repository) &&
							(input.runId === undefined || lease.runId === input.runId) &&
							(input.activeOnly !== true || lease.active),
					)
					.sort(newestFirst);
				return result(
					RelayMcpLeasesSchema,
					create(RelayMcpLeasesSchema, {
						leases: found.slice(0, limit),
						truncated: found.length > limit,
					}),
				);
			}),
	);

	server.registerTool(
		"get_lease",
		{
			title: "Get a lease",
			description:
				"One lease and its latest events, found among the account's most recent journal entries.",
			inputSchema: { leaseId: LeaseId },
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, "get_lease", READ_SCOPE, extra, async (caller) =>
				result(
					RelayMcpLeaseDetailSchema,
					await leaseDetail(services, caller.accountId, input.leaseId),
				),
			),
	);

	server.registerTool(
		"list_pending_jobs",
		{
			title: "List queued jobs without a lease",
			description:
				"Jobs the relay has admitted for the account's repositories that are still waiting for capacity, oldest first.",
			inputSchema: {
				repository: Repository.optional(),
				limit: z.number().int().min(1).max(200).optional(),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(
				services,
				"list_pending_jobs",
				READ_SCOPE,
				extra,
				async (caller) => {
					const limit = input.limit ?? 50;
					const repository = input.repository?.toLowerCase();
					const connections =
						(await configurationState(store)).configuration?.connections ?? [];
					const found = (await store.pendingJobs()).filter(
						(job) =>
							accountOwnsJob(connections, caller.accountId, job) &&
							(repository === undefined ||
								job.repository.toLowerCase() === repository),
					);
					return result(
						RelayMcpJobsSchema,
						create(RelayMcpJobsSchema, {
							jobs: found.slice(0, limit).map(jobView),
							truncated: found.length > limit,
						}),
					);
				},
			),
	);

	server.registerTool(
		"list_events",
		{
			title: "List journal events",
			description:
				"The account's events after a cursor, oldest first; without a cursor, its newest ones. The returned cursor is where to read from next. `more: true` means the read stopped before the end of the journal (read again at once, even if `events` is empty); `truncated: true` means a read of the newest events left older ones unread.",
			inputSchema: {
				cursor: Cursor.optional(),
				leaseId: LeaseId.optional(),
				repository: Repository.optional(),
				types: EventTypes.optional(),
				limit: z.number().int().min(1).max(200).optional(),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, "list_events", READ_SCOPE, extra, async (caller) =>
				eventsResult(
					services,
					caller.accountId,
					await readEvents(
						services,
						caller.accountId,
						input.cursor === undefined
							? undefined
							: positionOf(services.cursors(caller.accountId), input.cursor),
						input,
						input.limit ?? 50,
					),
					false,
				),
			),
	);

	server.registerTool(
		"wait_for_events",
		{
			title: "Wait for the next events",
			description:
				"Blocks until the account has an event after the cursor that matches the filters, or the timeout passes (timedOut: true). Call it again with the returned cursor to keep following; no polling or reminder is needed. Without a cursor it waits for what happens next. An empty result with `more: true` is neither: the journal is longer than one call reads, so call again at once.",
			inputSchema: {
				cursor: Cursor.optional(),
				timeoutSeconds: z
					.number()
					.min(0)
					.max(3600)
					.optional()
					.describe(
						"How long to wait. The host caps it; get_relay_status reports the cap.",
					),
				leaseId: LeaseId.optional(),
				repository: Repository.optional(),
				types: EventTypes.optional(),
				limit: z.number().int().min(1).max(200).optional(),
			},
			annotations: readOnly,
		},
		(input, extra) =>
			asTool(services, "wait_for_events", READ_SCOPE, extra, async (caller) => {
				const after =
					input.cursor === undefined
						? undefined
						: positionOf(services.cursors(caller.accountId), input.cursor);
				if (!services.beginWait(caller.accountId))
					throw new ControlError(
						429,
						"too many callers are waiting on this relay; retry shortly",
					);
				try {
					return await waitForEvents(services, caller, {
						after,
						timeoutMs: Math.min(
							services.waitMaxMs,
							input.timeoutSeconds === undefined
								? services.waitDefaultMs
								: Math.round(input.timeoutSeconds * 1000),
						),
						filter: input,
						limit: input.limit ?? 50,
					});
				} finally {
					services.endWait(caller.accountId);
				}
			}),
	);

	server.registerTool(
		"get_relay_status",
		{
			title: "Relay status",
			description:
				"Whether the relay is ready to admit work, its engines, whether this host pushes resource updates, how long wait_for_events may block, and how many calls and waits one account may have in progress.",
			annotations: readOnly,
		},
		(extra) =>
			asTool(services, "get_relay_status", READ_SCOPE, extra, async () => {
				const ready = await services.ready().catch(() => false);
				return result(
					RelayMcpStatusSchema,
					create(RelayMcpStatusSchema, {
						ready,
						engines: [{ id: services.engineId, ready }],
						subscriptions: services.subscriptions !== undefined,
						waitDefaultSeconds: Math.round(services.waitDefaultMs / 1000),
						waitMaxSeconds: Math.round(services.waitMaxMs / 1000),
						accountCalls: services.accountCalls,
						accountWaits: services.accountWaits,
						requestMessages: services.requestMessages,
					}),
				);
			}),
	);

	server.registerTool(
		"reconcile_lease",
		{
			title: "Reconcile a lease",
			description:
				"Settle a lease against a host workflow run you have verified. The relay still checks the host's identity, source, label, completion and runner cleanup; it cannot force-release running or ambiguous work.",
			inputSchema: {
				leaseId: LeaseId,
				hostRunId: z
					.number()
					.int()
					.positive()
					.describe("The id of the host workflow run that served the lease."),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		(input, extra) =>
			asTool(services, "reconcile_lease", WRITE_SCOPE, extra, async (caller) =>
				result(
					RelayMcpLeaseSchema,
					leaseView(
						await reconcileAccountLease(
							await services.relay(),
							store,
							caller.accountId,
							input.leaseId,
							input.hostRunId,
						),
					),
				),
			),
	);

	server.registerTool(
		"list_quarantined_webhooks",
		{
			title: "List quarantined webhook deliveries",
			description:
				"Deliveries for the account's repositories that failed too many times and were set aside. Their bodies are never returned.",
			annotations: readOnly,
		},
		(extra) =>
			asTool(
				services,
				"list_quarantined_webhooks",
				WRITE_SCOPE,
				extra,
				async (caller) =>
					result(
						RelayMcpQuarantineSchema,
						create(RelayMcpQuarantineSchema, {
							deliveries: (
								await quarantinedDeliveries(store, caller.accountId)
							).deliveries.map(quarantinedDeliveryView),
						}),
					),
			),
	);

	server.registerTool(
		"retry_quarantined_webhook",
		{
			title: "Retry a quarantined webhook delivery",
			description:
				"Put one quarantined delivery back in the inbox for the worker to process again.",
			inputSchema: {
				deliveryId: z
					.string()
					.regex(/^[A-Za-z0-9-]{1,100}$/)
					.describe("The delivery id from list_quarantined_webhooks."),
			},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		(input, extra) =>
			asTool(
				services,
				"retry_quarantined_webhook",
				WRITE_SCOPE,
				extra,
				async (caller) => {
					// The retry is fenced on the configuration it was decided under.
					const { revision } = await configurationState(store);
					await retryQuarantinedDelivery(
						store,
						caller.accountId,
						revision,
						input.deliveryId,
					);
					return result(
						RelayMcpRetrySchema,
						create(RelayMcpRetrySchema, {
							deliveryId: input.deliveryId,
							status: "queued",
						}),
					);
				},
			),
	);

	server.registerResource(
		"leases",
		RELAY_MCP_LEASES_URI,
		{
			title: "Leases",
			description: "The account's 100 newest leases.",
			mimeType: "application/json",
		},
		(uri, extra) =>
			asResource(services, extra, async (caller) => {
				const found = (await store.accountLeases(caller.accountId)).sort(
					newestFirst,
				);
				return resource(
					uri,
					RelayMcpLeasesSchema,
					create(RelayMcpLeasesSchema, {
						leases: found.slice(0, 100).map(leaseView),
						truncated: found.length > 100,
					}),
				);
			}),
	);

	server.registerResource(
		"lease",
		new ResourceTemplate(RELAY_MCP_LEASE_URI_TEMPLATE, { list: undefined }),
		{
			title: "Lease",
			description: "One lease and its latest events.",
			mimeType: "application/json",
		},
		(uri, variables, extra) =>
			asResource(services, extra, async (caller) => {
				const leaseId = [variables.leaseId].flat()[0] ?? "";
				if (!LEASE_ID.test(leaseId))
					throw new ControlError(404, "lease not found");
				return resource(
					uri,
					RelayMcpLeaseDetailSchema,
					await leaseDetail(services, caller.accountId, leaseId),
				);
			}),
	);

	server.registerResource(
		"events",
		RELAY_MCP_EVENTS_URI,
		{
			title: "Events",
			description:
				"The account's 100 newest journal events and the cursor to read on from.",
			mimeType: "application/json",
		},
		(uri, extra) =>
			asResource(services, extra, async (caller) => {
				const read = await readEvents(
					services,
					caller.accountId,
					undefined,
					{},
					100,
				);
				return resource(
					uri,
					RelayMcpEventsSchema,
					create(RelayMcpEventsSchema, {
						events: read.events,
						cursor: services.cursors(caller.accountId).encode(read.position),
						truncated: read.truncated,
					}),
				);
			}),
	);

	const subscriptions = services.subscriptions;
	if (subscriptions) {
		server.server.setRequestHandler(
			SubscribeRequestSchema,
			async (request, extra) => {
				const caller = callerOf(extra);
				if (!caller.scopes.includes(READ_SCOPE))
					throw new McpError(
						ErrorCode.InvalidRequest,
						`account scope required: ${READ_SCOPE}`,
					);
				if (!isRelayMcpResource(request.params.uri))
					throw new McpError(ErrorCode.InvalidParams, "unknown resource");
				await subscriptions.subscribe(caller.accountId, request.params.uri);
				return {};
			},
		);
		server.server.setRequestHandler(
			UnsubscribeRequestSchema,
			async (request) => {
				subscriptions.unsubscribe(request.params.uri);
				return {};
			},
		);
	}
	return server;
}
