import { create, type DescMessage, toJsonString } from "@bufbuild/protobuf";
import {
	accountOwnsJob,
	type CiEventPage,
	type EventCursor,
	type Lease,
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
import type { HostedRelay, HostedRelayStore } from "./hosted-relay.js";
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
/** How many journal events one read looks through for the ones a caller asked for. */
const EVENT_WINDOW = 500;
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

/** The store reads the MCP server makes, all of them scoped to one account. */
export type RelayMcpStore = AccountOperationsStore &
	Pick<HostedRelayStore, "accountLeases" | "pendingJobs"> & {
		eventsSince(cursor: EventCursor): Promise<CiEventPage>;
	};

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
	/** Admit one more blocked `wait_for_events`; false when too many are waiting. */
	beginWait: () => boolean;
	endWait: () => void;
	now: () => number;
	/** Resolves after `ms`, or as soon as the signal aborts. */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
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

/** Run a tool for a caller holding `scope`; a refusal is a tool error, not a thrown one. */
async function asTool(
	name: string,
	scope: string,
	extra: Extra,
	run: (caller: Caller) => Promise<CallToolResult>,
): Promise<CallToolResult> {
	let caller: Caller | undefined;
	try {
		caller = callerOf(extra);
		if (!caller.scopes.includes(scope))
			throw new ControlError(403, `account scope required: ${scope}`);
		return await run(caller);
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
	extra: Extra,
	read: (caller: Caller) => Promise<ReadResourceResult>,
): Promise<ReadResourceResult> {
	try {
		const caller = callerOf(extra);
		if (!caller.scopes.includes(READ_SCOPE))
			throw new ControlError(403, `account scope required: ${READ_SCOPE}`);
		return await read(caller);
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

/**
 * One read of the account's journal: the matching events after `after`, or
 * the newest matching ones without it, and the position to read from next.
 */
async function readEvents(
	store: RelayMcpStore,
	accountId: string,
	after: number | undefined,
	filter: EventFilter,
	limit: number,
): Promise<{ events: RelayMcpEvent[]; cursor: number }> {
	if (after === undefined) {
		const page = await store.eventsSince({ accountId, limit: EVENT_WINDOW });
		return {
			events: page.events
				.map(eventView)
				.filter((event) => matches(event, filter))
				.slice(-limit),
			cursor: page.cursor,
		};
	}
	const page = await store.eventsSince({
		accountId,
		after,
		limit: EVENT_WINDOW,
	});
	const found = page.events
		.map(eventView)
		.filter((event) => matches(event, filter));
	// More matched than fit: resume after the last one returned, not after
	// the ones left behind.
	const last = found.length > limit ? found[limit - 1] : undefined;
	return {
		events: found.slice(0, limit),
		cursor: last ? Number(last.cursor) : page.cursor,
	};
}

/**
 * Hold the request until the account's journal has a matching event after
 * the cursor, or the timeout passes. The journal is polled here, once, so
 * that no client has to poll the relay.
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
	const { store, now, sleep, pollMs } = services;
	const deadline = now() + wait.timeoutMs;
	// Without a cursor the wait starts now: only what happens next counts.
	let after =
		wait.after ??
		(await store.eventsSince({ accountId: caller.accountId, limit: 1 })).cursor;
	for (;;) {
		caller.signal.throwIfAborted();
		const read = await readEvents(
			store,
			caller.accountId,
			after,
			wait.filter,
			wait.limit,
		);
		if (read.events.length > 0)
			return result(
				RelayMcpEventsSchema,
				create(RelayMcpEventsSchema, {
					events: read.events,
					cursor: String(read.cursor),
				}),
			);
		// The journal moved but nothing matched: there may be more to read.
		if (read.cursor > after) {
			after = read.cursor;
			continue;
		}
		const remaining = deadline - now();
		if (remaining <= 0)
			return result(
				RelayMcpEventsSchema,
				create(RelayMcpEventsSchema, {
					cursor: String(after),
					timedOut: true,
				}),
			);
		await sleep(Math.min(pollMs, remaining), caller.signal);
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
	store: RelayMcpStore,
	accountId: string,
	leaseId: string,
) {
	const lease = await accountLease(store, accountId, leaseId);
	const recent = await readEvents(
		store,
		accountId,
		undefined,
		{ leaseId: lease.id },
		LEASE_EVENTS,
	);
	return create(RelayMcpLeaseDetailSchema, {
		lease: leaseView(lease),
		events: recent.events,
	});
}

const Cursor = z
	.string()
	.regex(/^(0|[1-9]\d{0,15})$/)
	.describe(
		"A position in the account's event journal: the `cursor` of an earlier result.",
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
			asTool("list_leases", READ_SCOPE, extra, async (caller) => {
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
			asTool("get_lease", READ_SCOPE, extra, async (caller) =>
				result(
					RelayMcpLeaseDetailSchema,
					await leaseDetail(store, caller.accountId, input.leaseId),
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
			asTool("list_pending_jobs", READ_SCOPE, extra, async (caller) => {
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
			}),
	);

	server.registerTool(
		"list_events",
		{
			title: "List journal events",
			description:
				"The account's events after a cursor, oldest first; without a cursor, its newest ones. The returned cursor is where to read from next.",
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
			asTool("list_events", READ_SCOPE, extra, async (caller) => {
				const read = await readEvents(
					store,
					caller.accountId,
					input.cursor === undefined ? undefined : Number(input.cursor),
					input,
					input.limit ?? 50,
				);
				return result(
					RelayMcpEventsSchema,
					create(RelayMcpEventsSchema, {
						events: read.events,
						cursor: String(read.cursor),
					}),
				);
			}),
	);

	server.registerTool(
		"wait_for_events",
		{
			title: "Wait for the next events",
			description:
				"Blocks until the account has an event after the cursor that matches the filters, or the timeout passes (timedOut: true). Call it again with the returned cursor to keep following; no polling or reminder is needed. Without a cursor it waits for what happens next.",
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
			asTool("wait_for_events", READ_SCOPE, extra, async (caller) => {
				if (!services.beginWait())
					throw new ControlError(
						429,
						"too many callers are waiting on this relay; retry shortly",
					);
				try {
					return await waitForEvents(services, caller, {
						after:
							input.cursor === undefined ? undefined : Number(input.cursor),
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
					services.endWait();
				}
			}),
	);

	server.registerTool(
		"get_relay_status",
		{
			title: "Relay status",
			description:
				"Whether the relay is ready to admit work, its engines, whether this host pushes resource updates, and how long wait_for_events may block.",
			annotations: readOnly,
		},
		(extra) =>
			asTool("get_relay_status", READ_SCOPE, extra, async () => {
				const ready = await services.ready().catch(() => false);
				return result(
					RelayMcpStatusSchema,
					create(RelayMcpStatusSchema, {
						ready,
						engines: [{ id: services.engineId, ready }],
						subscriptions: services.subscriptions !== undefined,
						waitDefaultSeconds: Math.round(services.waitDefaultMs / 1000),
						waitMaxSeconds: Math.round(services.waitMaxMs / 1000),
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
			asTool("reconcile_lease", WRITE_SCOPE, extra, async (caller) =>
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
			asTool("list_quarantined_webhooks", WRITE_SCOPE, extra, async (caller) =>
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
			asResource(extra, async (caller) => {
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
			asResource(extra, async (caller) => {
				const leaseId = [variables.leaseId].flat()[0] ?? "";
				if (!LEASE_ID.test(leaseId))
					throw new ControlError(404, "lease not found");
				return resource(
					uri,
					RelayMcpLeaseDetailSchema,
					await leaseDetail(store, caller.accountId, leaseId),
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
			asResource(extra, async (caller) => {
				const read = await readEvents(
					store,
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
						cursor: String(read.cursor),
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
