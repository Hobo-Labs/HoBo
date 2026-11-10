import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { create, type JsonObject } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	type Job,
	type Lease,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createControlAuthenticator } from "../src/control-auth.js";
import { createRelayHandler } from "../src/http-handler.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import {
	createRelayMcp,
	isRelayMcpPath,
	type RelayMcpOptions,
} from "../src/relay-mcp.js";
import { config, job, NOW, SECRET } from "./fixtures.js";

const ORIGIN = "https://ci.example.test";
const LATER = "2026-10-26T12:01:00Z";
const TOOLS = [
	"get_lease",
	"get_relay_status",
	"list_events",
	"list_leases",
	"list_pending_jobs",
	"list_quarantined_webhooks",
	"reconcile_lease",
	"retry_quarantined_webhook",
	"wait_for_events",
];

/** A bearer of the right shape, made for this run and matched by its digest. */
function credential(accountId: string, scopes: string[]) {
	const token = randomBytes(24).toString("base64url");
	return {
		authorization: `Bearer ${token}`,
		binding: {
			accountId,
			installationIds: [accountId === "account-a" ? 10 : 20],
			tokenSha256: createHash("sha256").update(token).digest("hex"),
			scopes,
		},
	};
}

/** The fixture account and a second one with its own repository. */
function twoAccounts() {
	const base = config();
	const [account] = base.accounts;
	const [connection] = base.connections;
	if (!account || !connection) throw new Error("fixture account");
	return create(ConfigurationSchema, {
		accounts: [
			account,
			create(AccountSchema, {
				...account,
				id: "account-b",
				offers: account.offers.map((offer) =>
					create(OfferSchema, {
						...offer,
						id: "blacksmith-b",
						providerAccountId: "owned-by-account-b",
					}),
				),
			}),
		],
		connections: [
			connection,
			create(ConnectionSchema, {
				...connection,
				accountId: "account-b",
				repository: "other/repo",
				repositoryId: 202,
				installationId: 20,
			}),
		],
	});
}

function foreignJob(id: number): Job {
	const other = job(id);
	other.repositoryId = 202;
	other.installationId = 20;
	other.repository = "other/repo";
	return other;
}

const Text = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	structuredContent: z.record(z.string(), z.unknown()).optional(),
});
const EventView = z.object({
	cursor: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
	type: z.string(),
	at: z.string(),
	leaseId: z.string(),
	state: z.string(),
	repository: z.string(),
	jobId: z.number(),
});
const CURSOR = /^[A-Za-z0-9_-]{22}$/;
const Events = z.object({
	events: z.array(EventView),
	cursor: z.string().regex(CURSOR),
	timedOut: z.boolean(),
	more: z.boolean(),
	truncated: z.boolean(),
});
const LeaseView = z.object({
	id: z.string(),
	state: z.string(),
	active: z.boolean(),
	repository: z.string(),
	jobId: z.number(),
	runId: z.number(),
});
const Leases = z.object({ leases: z.array(LeaseView), truncated: z.boolean() });
const Resource = z.object({
	contents: z.array(
		z.object({ uri: z.string(), mimeType: z.string(), text: z.string() }),
	),
});

/** Let the event loop turn a few times: timers, sockets and queued passes run. */
async function turns(count = 4): Promise<void> {
	for (let turn = 0; turn < count; turn++)
		await new Promise((done) => setImmediate(done));
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** What a test may do to the store the server reads, to hold or fail a read. */
type StoreHooks = {
	/** Runs before each journal read, to move the journal under a reader. */
	beforeJournalRead?: (store: SqliteCiStore) => Promise<void>;
	/** Runs before each read of an account's leases. */
	beforeLeaseRead?: () => Promise<void>;
};

async function setup(
	overrides: Partial<RelayMcpOptions> & Pick<RelayMcpOptions, "sessions">,
	hooks: StoreHooks = {},
) {
	const store = new SqliteCiStore(":memory:");
	const configuration = twoAccounts();
	const { revision } = await store.configure(configuration, 0, NOW);
	const [accountA, accountB] = configuration.accounts;
	if (!accountA || !accountB) throw new Error("fixture accounts");
	const tokens = {
		a: credential("account-a", ["policy:read", "operations:write"]),
		aReadOnly: credential("account-a", ["policy:read"]),
		aPolicyWriter: credential("account-a", ["policy:write"]),
		b: credential("account-b", ["policy:read", "operations:write"]),
	};
	const reconciled: Array<[string, number]> = [];
	let journalReads = 0;
	const mcp = createRelayMcp({
		store: {
			configuration: () => store.configuration(),
			get: (id) => store.get(id),
			accountLeases: async (accountId) => {
				await hooks.beforeLeaseRead?.();
				return store.accountLeases(accountId);
			},
			pendingJobs: () => store.pendingJobs(),
			quarantinedWebhooks: (accountId, expected) =>
				store.quarantinedWebhooks(accountId, expected),
			retryQuarantinedWebhook: (accountId, expected, deliveryId) =>
				store.retryQuarantinedWebhook(accountId, expected, deliveryId),
			journalHead: async () => {
				await hooks.beforeJournalRead?.(store);
				return store.journalHead();
			},
			eventsSince: async (cursor) => {
				journalReads++;
				await hooks.beforeJournalRead?.(store);
				return store.eventsSince(cursor);
			},
			leaseEvents: (query) => store.leaseEvents(query),
		},
		relay: async () => ({
			reconcile: async (id, hostRunId) => {
				reconciled.push([id, hostRunId]);
			},
		}),
		authenticate: createControlAuthenticator(
			JSON.stringify({
				tokens: Object.values(tokens).map((entry) => entry.binding),
			}),
		),
		ready: async () => true,
		publicOrigin: ORIGIN,
		cursorSecret: SECRET,
		...overrides,
	});
	const handle = createRelayHandler({
		application: {
			ingestWebhook: async () => "accepted",
			claim: async () => new Response(null, { status: 403 }),
			control: async () => undefined,
			ready: async () => true,
			mcp: mcp.handle,
		},
		webhookSecret: SECRET,
	});
	closers.push(async () => {
		await mcp.close();
		store.close();
	});
	/** An MCP client over the real handler, as the holder of one credential. */
	async function connect(authorization: string, path = "/mcp") {
		const client = new Client({ name: "relay-mcp-test", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(path, ORIGIN), {
			fetch: (url, init) => handle(new Request(url, init)),
			requestInit: { headers: { authorization } },
		});
		await client.connect(transport);
		closers.push(() => client.close());
		return {
			client,
			transport,
			call: async (name: string, input: Record<string, string | number> = {}) =>
				Text.parse(await client.callTool({ name, arguments: input })),
			read: async (uri: string) =>
				Resource.parse(await client.readResource({ uri })),
		};
	}
	return {
		store,
		mcp,
		handle,
		tokens,
		revision,
		accountA,
		accountB,
		reconciled,
		journalReads: () => journalReads,
		connect,
	};
}

/** Account A: one queued job that got a lease, and one still waiting. Account B: one lease. */
async function seed(h: Awaited<ReturnType<typeof setup>>) {
	await h.store.queue(job(1), NOW, h.revision);
	await h.store.queue(job(2), NOW, h.revision);
	await h.store.queue(foreignJob(3), NOW, h.revision);
	const mine = await h.store.reserve(h.accountA, job(1), NOW, h.revision);
	const theirs = await h.store.reserve(
		h.accountB,
		foreignJob(3),
		NOW,
		h.revision,
	);
	if (!mine || !theirs) throw new Error("fixture reservation");
	return { mine, theirs };
}

async function dispatch(
	h: Awaited<ReturnType<typeof setup>>,
	lease: Lease,
	at = LATER,
) {
	await h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.state = "dispatching";
		},
		"ci.DispatchRequested",
		at,
		h.revision,
	);
}

function post(body: string, headers: Record<string, string> = {}) {
	return new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			...headers,
		},
		body,
	});
}
const PING = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

describe("relay MCP boundary", () => {
	it("answers no one without the account API's credentials and scopes", async () => {
		const h = await setup({ sessions: "none" });
		const anonymous = await h.handle(post(PING));
		expect(anonymous.status).toBe(401);
		expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
		expect(anonymous.headers.get("cache-control")).toBe("no-store");
		expect(await anonymous.json()).toEqual({
			error: "account authentication required",
		});
		const forged = await h.handle(
			post(PING, {
				authorization: `Bearer ${randomBytes(24).toString("base64url")}`,
			}),
		);
		expect(forged.status).toBe(401);
		// A credential that may only write policy has no business here.
		const wrongScope = await h.handle(
			post(PING, { authorization: h.tokens.aPolicyWriter.authorization }),
		);
		expect(wrongScope.status).toBe(403);
		expect(await wrongScope.json()).toEqual({
			error: "account scope required",
		});
		const elsewhere = await h.handle(
			post(PING, {
				authorization: h.tokens.a.authorization,
				origin: "https://attacker.example",
			}),
		);
		expect(elsewhere.status).toBe(403);
		expect(await elsewhere.json()).toEqual({ error: "origin not allowed" });
		const sameOrigin = await h.handle(
			post(PING, { authorization: h.tokens.a.authorization, origin: ORIGIN }),
		);
		expect(sameOrigin.status).toBe(200);
		expect(sameOrigin.headers.get("cache-control")).toBe("no-store");
		expect(await sameOrigin.json()).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {},
		});
	});

	it("bounds the request and refuses what a host without sessions cannot serve", async () => {
		const h = await setup({ sessions: "none" });
		const authorization = h.tokens.a.authorization;
		const listen = await h.handle(
			new Request(`${ORIGIN}/mcp`, {
				headers: { authorization, accept: "text/event-stream" },
			}),
		);
		expect(listen.status).toBe(405);
		expect(listen.headers.get("allow")).toBe("POST");
		const huge = await h.handle(
			post(`{"padding":"${"x".repeat(1024 * 1024)}"}`, { authorization }),
		);
		expect(huge.status).toBe(413);
		expect(await huge.json()).toEqual({ error: "request body too large" });
		// The engine mount serves the same endpoint.
		const mounted = await h.handle(
			new Request(`${ORIGIN}/engines/gh-actions/mcp`, {
				method: "POST",
				headers: {
					authorization,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: PING,
			}),
		);
		expect(mounted.status).toBe(200);
		expect(isRelayMcpPath("/mcp")).toBe(true);
		expect(isRelayMcpPath("/engines/gh-actions/mcp")).toBe(true);
		expect(isRelayMcpPath("/mcp/extra")).toBe(false);
		expect(isRelayMcpPath("/v1/accounts/self/leases")).toBe(false);
	});

	it("answers 404 on a host that serves no MCP", async () => {
		const handle = createRelayHandler({
			application: {
				ingestWebhook: async () => "accepted",
				claim: async () => new Response(null, { status: 403 }),
				control: async () => undefined,
				ready: async () => true,
			},
			webhookSecret: SECRET,
		});
		const response = await handle(post(PING));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not found" });
	});
});

describe("relay MCP tools and resources", () => {
	it("serves every tool and resource without sessions or subscriptions", async () => {
		const h = await setup({ sessions: "none" });
		const { mine } = await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		// A host that does not outlive the request cannot push: it says so.
		expect(a.client.getServerCapabilities()?.resources?.subscribe).toBe(
			undefined,
		);
		expect(a.transport.sessionId).toBe(undefined);
		expect(
			(await a.client.listTools()).tools.map((tool) => tool.name).sort(),
		).toEqual(TOOLS);
		expect(
			(await a.client.listResources()).resources
				.map((entry) => entry.uri)
				.sort(),
		).toEqual(["hobo-ci://events", "hobo-ci://leases"]);
		expect(
			(await a.client.listResourceTemplates()).resourceTemplates.map(
				(entry) => entry.uriTemplate,
			),
		).toEqual(["hobo-ci://leases/{leaseId}"]);

		const leases = Leases.parse(
			(await a.call("list_leases")).structuredContent,
		);
		expect(leases).toEqual({
			leases: [
				{
					id: mine.id,
					state: "reserved",
					active: true,
					repository: "org/repo",
					jobId: 1,
					runId: 11,
				},
			],
			truncated: false,
		});
		for (const [filter, count] of [
			[{ state: "reserved" }, 1],
			[{ state: "completed" }, 0],
			[{ repository: "ORG/Repo" }, 1],
			[{ repository: "other/repo" }, 0],
			[{ runId: 11 }, 1],
			[{ runId: 12 }, 0],
		] as const)
			expect(
				Leases.parse((await a.call("list_leases", filter)).structuredContent)
					.leases.length,
			).toBe(count);

		const detail = await a.call("get_lease", { leaseId: mine.id });
		expect(detail.structuredContent).toMatchObject({
			lease: { id: mine.id, state: "reserved", jobId: 1 },
			events: [{ type: "ci.LeaseReserved", leaseId: mine.id }],
		});

		// Job 2 is admitted and waiting: the offer serves one job at a time.
		expect((await a.call("list_pending_jobs")).structuredContent).toMatchObject(
			{
				jobs: [{ id: 2, runId: 11, repository: "org/repo", labels: ["hobo"] }],
				truncated: false,
			},
		);

		const newest = Events.parse(
			(await a.call("list_events")).structuredContent,
		);
		expect(newest.events.map((event) => [event.type, event.jobId])).toEqual([
			["ci.JobQueued", 1],
			["ci.JobQueued", 2],
			["ci.LeaseReserved", 1],
		]);
		expect(newest.timedOut).toBe(false);
		await dispatch(h, mine);
		const next = Events.parse(
			(await a.call("list_events", { cursor: newest.cursor }))
				.structuredContent,
		);
		expect(next.events).toMatchObject([
			{ type: "ci.DispatchRequested", leaseId: mine.id, state: "dispatching" },
		]);
		// A cursor is a token, not a number: it only says "after here".
		expect(next.cursor).not.toBe(newest.cursor);
		expect(next.more).toBe(false);
		expect(
			Events.parse(
				(await a.call("list_events", { cursor: "0", limit: 2 }))
					.structuredContent,
			).events.map((event) => event.type),
		).toEqual(["ci.JobQueued", "ci.JobQueued"]);

		expect((await a.call("get_relay_status")).structuredContent).toEqual({
			ready: true,
			engines: [{ id: "gh-actions", ready: true }],
			subscriptions: false,
			waitDefaultSeconds: 25,
			waitMaxSeconds: 50,
			accountCalls: 8,
			accountWaits: 8,
			requestMessages: 8,
		});

		const reconciled = await a.call("reconcile_lease", {
			leaseId: mine.id,
			hostRunId: 77,
		});
		expect(reconciled.isError).toBe(undefined);
		expect(reconciled.structuredContent).toMatchObject({ id: mine.id });
		expect(h.reconciled).toEqual([[mine.id, 77]]);

		expect(Resource.parse(await a.read("hobo-ci://leases")).contents).toEqual([
			{
				uri: "hobo-ci://leases",
				mimeType: "application/json",
				text: expect.stringContaining(mine.id),
			},
		]);
		const one = await a.read(`hobo-ci://leases/${mine.id}`);
		expect(JSON.parse(one.contents[0]?.text ?? "")).toMatchObject({
			lease: { id: mine.id },
			events: [{ type: "ci.LeaseReserved" }, { type: "ci.DispatchRequested" }],
		});
		const feed = Events.parse(
			JSON.parse((await a.read("hobo-ci://events")).contents[0]?.text ?? ""),
		);
		expect(feed.events.length).toBe(4);
		expect(feed.cursor).toBe(next.cursor);
	});

	it("holds a write to the operations scope and reports a refusal as a tool error", async () => {
		const h = await setup({ sessions: "none" });
		const { mine } = await seed(h);
		const reader = await h.connect(h.tokens.aReadOnly.authorization);
		for (const [name, input] of [
			["reconcile_lease", { leaseId: mine.id, hostRunId: 77 }],
			["retry_quarantined_webhook", { deliveryId: "delivery-1" }],
			["list_quarantined_webhooks", {}],
		] as const) {
			const refused = await reader.call(name, input);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toBe(
				"account scope required: operations:write",
			);
		}
		expect(h.reconciled).toEqual([]);
		expect((await reader.call("list_leases")).isError).toBe(undefined);
		const writer = await h.connect(h.tokens.a.authorization);
		const missing = await writer.call("retry_quarantined_webhook", {
			deliveryId: "delivery-1",
		});
		expect(missing.isError).toBe(true);
		expect(missing.content[0]?.text).toBe("quarantined delivery not found");
	});

	it("lists and retries the account's quarantined deliveries", async () => {
		const h = await setup({ sessions: "none" });
		for (const [deliveryId, installationId, repositoryId] of [
			["poison-a", 10, 101],
			["poison-b", 20, 202],
		] as const)
			await h.store.acceptWebhook({
				deliveryId,
				event: "workflow_job",
				installationId,
				repositoryId,
				rawBody: Buffer.from(`{"poisonBody":"${deliveryId}"}`),
				receivedAt: NOW,
			});
		let at = Date.parse(NOW);
		for (let attempt = 0; attempt < 40; attempt++) {
			const claim = await h.store.claimWebhook(
				new Date(at).toISOString(),
				1_000,
			);
			if (claim)
				await h.store.failWebhook(
					claim.deliveryId,
					claim.token,
					new Date(at).toISOString(),
				);
			at += 301_000;
		}
		const a = await h.connect(h.tokens.a.authorization);
		const listed = await a.call("list_quarantined_webhooks");
		expect(listed.structuredContent).toMatchObject({
			deliveries: [
				{
					deliveryId: "poison-a",
					event: "workflow_job",
					installationId: 10,
					repositoryId: 101,
				},
			],
		});
		// The body that poisoned the worker is never handed back.
		expect(listed.content[0]?.text).not.toContain("poisonBody");
		const foreign = await a.call("retry_quarantined_webhook", {
			deliveryId: "poison-b",
		});
		expect(foreign.isError).toBe(true);
		expect(
			(await a.call("retry_quarantined_webhook", { deliveryId: "poison-a" }))
				.structuredContent,
		).toEqual({ deliveryId: "poison-a", status: "queued" });
		expect(
			(await a.call("list_quarantined_webhooks")).structuredContent,
		).toEqual({ deliveries: [] });
	});

	it("never shows one account another's leases, jobs or events", async () => {
		const h = await setup({ sessions: "none" });
		const { mine, theirs } = await seed(h);
		await dispatch(h, mine);
		const a = await h.connect(h.tokens.a.authorization);
		const b = await h.connect(h.tokens.b.authorization);
		for (const [client, own, foreign, foreignRepository] of [
			[a, mine, theirs, "other/repo"],
			[b, theirs, mine, "org/repo"],
		] as const) {
			const outputs = [
				await client.call("list_leases"),
				await client.call("list_pending_jobs"),
				await client.call("list_events", { cursor: "0" }),
				await client.call("list_events"),
				await client.call("get_lease", { leaseId: own.id }),
			].map((output) => output.content[0]?.text ?? "");
			const resources = [
				await client.read("hobo-ci://leases"),
				await client.read("hobo-ci://events"),
				await client.read(`hobo-ci://leases/${own.id}`),
			].map((output) => output.contents[0]?.text ?? "");
			for (const text of [...outputs, ...resources]) {
				expect(text).not.toContain(foreign.id);
				expect(text).not.toContain(foreignRepository);
				// No stored event detail, credential or sandbox identity leaves the relay.
				expect(text).not.toMatch(
					/detail|token|jit|sandboxSessionId|sandboxName|budgetPolicyDigest/i,
				);
			}
			expect(outputs[0]).toContain(own.id);
			const probe = await client.call("get_lease", { leaseId: foreign.id });
			expect(probe.isError).toBe(true);
			expect(probe.content[0]?.text).toBe("lease not found");
			await expect(
				client.read(`hobo-ci://leases/${foreign.id}`),
			).rejects.toThrow(/lease not found/);
			const reconcile = await client.call("reconcile_lease", {
				leaseId: foreign.id,
				hostRunId: 5,
			});
			expect(reconcile.isError).toBe(true);
		}
		expect(h.reconciled).toEqual([]);
		// Account B's only pending job was reserved; A's second job is A's alone.
		expect((await b.call("list_pending_jobs")).structuredContent).toEqual({
			jobs: [],
			truncated: false,
		});
	});
});

describe("relay MCP change feed", () => {
	/** A clock the wait reads and a sleep that moves it; no test waits in real time. */
	function fakeTime() {
		let clock = 1_000_000;
		const slept: number[] = [];
		let onSleep: (count: number) => Promise<void> = async () => undefined;
		return {
			now: () => clock,
			slept,
			whenSleeping(hook: (count: number) => Promise<void>) {
				onSleep = hook;
			},
			sleep: async (ms: number) => {
				slept.push(ms);
				clock += ms;
				await onSleep(slept.length);
			},
		};
	}

	it("returns from wait_for_events as soon as the account has a new event", async () => {
		const time = fakeTime();
		const h = await setup({
			sessions: "none",
			now: time.now,
			sleep: time.sleep,
		});
		const { mine, theirs } = await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const start = Events.parse((await a.call("list_events")).structuredContent);
		// The first poll finds nothing; account B's lease moves, which is not
		// A's news; then A's own lease moves.
		time.whenSleeping(async (count) => {
			if (count === 1) await dispatch(h, theirs);
			if (count === 2) await dispatch(h, mine);
		});
		const waited = Events.parse(
			(await a.call("wait_for_events", { cursor: start.cursor }))
				.structuredContent,
		);
		expect(waited.timedOut).toBe(false);
		expect(waited.events).toMatchObject([
			{ type: "ci.DispatchRequested", leaseId: mine.id, state: "dispatching" },
		]);
		expect(time.slept).toEqual([1_000, 1_000]);
		// Following on from the returned cursor finds nothing twice.
		time.whenSleeping(async () => undefined);
		const again = Events.parse(
			(
				await a.call("wait_for_events", {
					cursor: waited.cursor,
					timeoutSeconds: 3,
				})
			).structuredContent,
		);
		expect(again).toEqual({
			events: [],
			cursor: waited.cursor,
			timedOut: true,
			more: false,
			truncated: false,
		});
	});

	it("times out, capped by the host, without an event", async () => {
		const time = fakeTime();
		const h = await setup({
			sessions: "none",
			now: time.now,
			sleep: time.sleep,
		});
		await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const before = time.now();
		// No cursor: the wait starts now, so what is already journalled is not news.
		const idle = Events.parse(
			(await a.call("wait_for_events")).structuredContent,
		);
		expect(idle.events).toEqual([]);
		expect(idle.timedOut).toBe(true);
		expect(time.now() - before).toBe(25_000);
		expect(idle.cursor).toMatch(CURSOR);
		const capped = time.now();
		await a.call("wait_for_events", { timeoutSeconds: 3600 });
		expect(time.now() - capped).toBe(50_000);
		const instant = time.slept.length;
		await a.call("wait_for_events", { timeoutSeconds: 0 });
		expect(time.slept.length).toBe(instant);
	});

	it("ends at its timeout even while events it did not ask for keep arriving", async () => {
		let clock = 0;
		let queued = 100;
		const h = await setup(
			{
				sessions: "none",
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			},
			{
				// Every look at the journal finds one more job queued.
				beforeJournalRead: async (store) => {
					await store.queue(job(queued++), LATER, 1);
				},
			},
		);
		const a = await h.connect(h.tokens.a.authorization);
		const waited = Events.parse(
			(
				await a.client.callTool({
					name: "wait_for_events",
					arguments: {
						cursor: "0",
						types: ["ci.LeaseCancelled"],
						timeoutSeconds: 5,
					},
				})
			).structuredContent,
		);
		expect(waited.events).toEqual([]);
		expect(waited.timedOut).toBe(true);
		expect(waited.more).toBe(false);
		// One read a second for five seconds, and the one at the deadline.
		expect(h.journalReads()).toBe(6);
		expect(clock).toBe(5_000);
	});

	it("waits only for the lease, repository and event types asked for", async () => {
		const time = fakeTime();
		const h = await setup({
			sessions: "none",
			now: time.now,
			sleep: time.sleep,
		});
		const { mine } = await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const start = Events.parse((await a.call("list_events")).structuredContent);
		time.whenSleeping(async (count) => {
			// A newly queued job is not the cancellation being waited for.
			if (count === 1) await h.store.queue(job(9), LATER, h.revision);
			if (count === 2) await dispatch(h, mine);
		});
		const typed = Events.parse(
			(
				await a.client.callTool({
					name: "wait_for_events",
					arguments: {
						cursor: start.cursor,
						leaseId: mine.id,
						repository: "ORG/repo",
						types: ["ci.DispatchRequested", "ci.LeaseCancelled"],
					},
				})
			).structuredContent,
		);
		expect(typed.events.map((event) => event.type)).toEqual([
			"ci.DispatchRequested",
		]);
		const elsewhere = Events.parse(
			(
				await a.call("wait_for_events", {
					cursor: start.cursor,
					repository: "org/another",
					timeoutSeconds: 2,
				})
			).structuredContent,
		);
		expect(elsewhere).toMatchObject({ events: [], timedOut: true });
	});

	it("stops waiting when the caller hangs up, and bounds how many wait", async () => {
		const time = fakeTime();
		const h = await setup({
			sessions: "none",
			now: time.now,
			sleep: time.sleep,
			maxWaits: 1,
		});
		await seed(h);
		const hangUp = new AbortController();
		let release = (): void => undefined;
		const sleeping = new Promise<void>((entered) => {
			time.whenSleeping(async () => {
				entered();
				await new Promise<void>((done) => {
					release = done;
				});
			});
		});
		const waiting = h.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization: h.tokens.a.authorization,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "wait_for_events", arguments: {} },
				}),
				signal: hangUp.signal,
			}),
		);
		await sleeping;
		// One caller is waiting; the relay will not hold a second.
		const a = await h.connect(h.tokens.a.authorization);
		const second = await a.call("wait_for_events");
		expect(second.isError).toBe(true);
		expect(second.content[0]?.text).toMatch(/too many callers are waiting/);
		hangUp.abort();
		expect((await waiting).status).toBe(400);
		release();
		time.whenSleeping(async () => undefined);
		// The abandoned wait notices at its next pass and gives its place back.
		await turns();
		expect(
			(await a.call("wait_for_events", { timeoutSeconds: 1 })).isError,
		).toBe(undefined);
	});
});

describe("relay MCP sessions", () => {
	/** A sleep the test releases by hand: one release is one pass of the pump. */
	function manualPump() {
		const sleepers: Array<() => void> = [];
		let asleep: () => void = () => undefined;
		return {
			sleep: (_ms: number, signal: AbortSignal) =>
				new Promise<void>((resolve) => {
					sleepers.push(resolve);
					signal.addEventListener("abort", () => resolve(), { once: true });
					asleep();
				}),
			/** Resolves once the pump is waiting for its next pass. */
			idle: () =>
				new Promise<void>((resolve) => {
					if (sleepers.length > 0) resolve();
					else asleep = resolve;
				}),
			pass() {
				asleep = () => undefined;
				for (const wake of sleepers.splice(0)) wake();
			},
		};
	}

	it("pushes resource updates to a subscribed session when its account's journal moves", async () => {
		const pump = manualPump();
		const h = await setup({ sessions: "memory", sleep: pump.sleep });
		const { mine, theirs } = await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		expect(a.client.getServerCapabilities()?.resources?.subscribe).toBe(true);
		expect(a.transport.sessionId).toMatch(/^[a-f0-9-]{36}$/);
		expect((await a.call("get_relay_status")).structuredContent).toMatchObject({
			subscriptions: true,
		});
		const updates: string[] = [];
		let notified = (): void => undefined;
		a.client.setNotificationHandler(
			ResourceUpdatedNotificationSchema,
			(notification) => {
				updates.push(notification.params.uri);
				notified();
			},
		);
		const mineUri = `hobo-ci://leases/${mine.id}`;
		const theirsUri = `hobo-ci://leases/${theirs.id}`;
		// Nobody is subscribed: the journal is not being read.
		const idleReads = h.journalReads();
		await a.client.subscribeResource({ uri: "hobo-ci://events" });
		await a.client.subscribeResource({ uri: mineUri });
		// Subscribing to another account's lease is accepted and never fires.
		await a.client.subscribeResource({ uri: theirsUri });
		await expect(
			a.client.subscribeResource({ uri: "hobo-ci://configuration" }),
		).rejects.toThrow(/unknown resource/);
		expect(h.journalReads()).toBeGreaterThan(idleReads);
		await pump.idle();
		expect(updates).toEqual([]);

		const twice = new Promise<void>((resolve) => {
			notified = () => {
				if (updates.length === 2) resolve();
			};
		});
		await dispatch(h, theirs);
		await dispatch(h, mine);
		pump.pass();
		await twice;
		expect(updates.sort()).toEqual(["hobo-ci://events", mineUri].sort());
		// The notification says what changed; the resource is read for the change.
		const detail = await a.read(mineUri);
		expect(JSON.parse(detail.contents[0]?.text ?? "")).toMatchObject({
			lease: { id: mine.id, state: "dispatching" },
		});

		// Once the last subscription goes, the pump stops reading the journal.
		await a.client.unsubscribeResource({ uri: "hobo-ci://events" });
		await a.client.unsubscribeResource({ uri: mineUri });
		await a.client.unsubscribeResource({ uri: theirsUri });
		await pump.idle();
		pump.pass();
		await new Promise((done) => setImmediate(done));
		const settled = h.journalReads();
		pump.pass();
		await new Promise((done) => setImmediate(done));
		expect(h.journalReads()).toBe(settled);
	});

	it("keeps a session to the account that opened it, and to a bounded number", async () => {
		let clock = 0;
		const h = await setup({
			sessions: "memory",
			maxSessions: 2,
			maxSessionsPerAccount: 1,
			sessionIdleMs: 60_000,
			now: () => clock,
		});
		await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const sessionId = a.transport.sessionId ?? "";
		const list = (authorization: string, session: string) =>
			h.handle(
				post('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', {
					authorization,
					"mcp-session-id": session,
				}),
			);
		// Account B naming A's session finds nothing, exactly as for an unknown id.
		const stolen = await list(h.tokens.b.authorization, sessionId);
		expect(stolen.status).toBe(404);
		expect(await stolen.json()).toEqual({ error: "session not found" });
		expect(
			(
				await list(
					h.tokens.a.authorization,
					"00000000-0000-4000-8000-000000000000",
				)
			).status,
		).toBe(404);
		expect((await list(h.tokens.a.authorization, sessionId)).status).toBe(200);
		// The same account with fewer scopes still reaches the session, as itself.
		const lesser = await h.handle(
			post(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "reconcile_lease",
						arguments: {
							leaseId: "01234567-89ab-4cde-8fab-0123456789ab",
							hostRunId: 1,
						},
					},
				}),
				{
					authorization: h.tokens.aReadOnly.authorization,
					"mcp-session-id": sessionId,
				},
			),
		);
		expect(await lesser.text()).toContain(
			"account scope required: operations:write",
		);

		const initialize = (authorization: string) =>
			h.handle(
				post(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "second", version: "1.0.0" },
						},
					}),
					{ authorization },
				),
			);
		// The client's own event stream keeps A's session from being idle.
		clock = 120_000;
		const crowded = await initialize(h.tokens.a.authorization);
		expect(crowded.status).toBe(429);
		expect(crowded.headers.get("retry-after")).toBe("30");
		expect(await crowded.json()).toEqual({
			error: "too many MCP sessions; close one or retry later",
		});
		// Without a session, only an initialize request is served.
		const loose = await h.handle(
			post('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', {
				authorization: h.tokens.b.authorization,
			}),
		);
		expect(loose.status).toBe(400);
		const second = await initialize(h.tokens.b.authorization);
		expect(second.status).toBe(200);
		const secondId = second.headers.get("mcp-session-id") ?? "";
		expect(secondId).toMatch(/^[a-f0-9-]{36}$/);
		await second.body?.cancel();
		// B's session holds no stream: left alone, it is closed and its place freed.
		clock = 300_000;
		const replaced = await initialize(h.tokens.b.authorization);
		expect(replaced.status).toBe(200);
		await replaced.body?.cancel();
		expect((await list(h.tokens.b.authorization, secondId)).status).toBe(404);
		// A client ending its session frees it at once.
		await a.transport.terminateSession();
		expect((await list(h.tokens.a.authorization, sessionId)).status).toBe(404);
	});

	it("ends a session's wait when the caller of that request hangs up", async () => {
		let clock = 0;
		let release = (): void => undefined;
		let entered = (): void => undefined;
		const h = await setup({
			sessions: "memory",
			maxWaits: 1,
			now: () => clock,
			// Every sleep holds until the test lets it go: a wait that kept
			// going after its caller left would stay blocked in the next one.
			sleep: async (ms) => {
				clock += ms;
				entered();
				await new Promise<void>((done) => {
					release = done;
				});
			},
		});
		await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const sleeping = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const hangUp = new AbortController();
		const waiting = await h.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization: h.tokens.a.authorization,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-session-id": a.transport.sessionId ?? "",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 91,
					method: "tools/call",
					params: { name: "wait_for_events", arguments: {} },
				}),
				signal: hangUp.signal,
			}),
		);
		// The answer is an event stream that stays open while the tool waits.
		expect(waiting.status).toBe(200);
		expect(waiting.headers.get("content-type")).toBe("text/event-stream");
		await sleeping;
		expect((await a.call("wait_for_events")).content[0]?.text).toMatch(
			/too many callers are waiting/,
		);
		// Only that request ended: the session itself is still there.
		hangUp.abort();
		await waiting.body?.cancel();
		release();
		await turns();
		const next = await a.call("wait_for_events", { timeoutSeconds: 0 });
		expect(next.isError).toBe(undefined);
		expect(next.structuredContent).toMatchObject({ timedOut: true });
	});

	it("ends every session when the host shuts down", async () => {
		const pump = manualPump();
		const h = await setup({ sessions: "memory", sleep: pump.sleep });
		await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		await a.client.subscribeResource({ uri: "hobo-ci://events" });
		const stream = await h.handle(
			new Request(`${ORIGIN}/mcp`, {
				headers: {
					authorization: h.tokens.b.authorization,
					accept: "text/event-stream",
				},
			}),
		);
		// No session, no stream.
		expect(stream.status).toBe(400);
		const sessionId = a.transport.sessionId ?? "";
		await h.mcp.close();
		const after = await h.handle(
			post(PING, {
				authorization: h.tokens.a.authorization,
				"mcp-session-id": sessionId,
			}),
		);
		expect(after.status).toBe(503);
		expect(await after.json()).toEqual({ error: "service unavailable" });
	});

	it("streams a subscription's update through the Node host", async () => {
		const h = await setup({ sessions: "memory", pollMs: 5 });
		const { mine } = await seed(h);
		const server = createServer();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || address === null || !("port" in address))
			throw new Error("listener address");
		const origin = `http://127.0.0.1:${address.port}`;
		const node = createNodeRelayHandler({
			origin,
			allowLoopbackHttp: true,
			handle: h.handle,
			streams: isRelayMcpPath,
		});
		server.on("request", (request, response) => {
			void node(request, response);
		});
		const client = new Client({ name: "relay-mcp-node", version: "1.0.0" });
		closers.push(async () => {
			await client.close();
			await h.mcp.close();
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
		});
		await client.connect(
			new StreamableHTTPClientTransport(new URL("/mcp", origin), {
				requestInit: {
					headers: { authorization: h.tokens.a.authorization },
				},
			}),
		);
		const updated = new Promise<string>((resolve) => {
			client.setNotificationHandler(
				ResourceUpdatedNotificationSchema,
				(notification) => resolve(notification.params.uri),
			);
		});
		await client.subscribeResource({ uri: "hobo-ci://leases" });
		await dispatch(h, mine);
		expect(await updated).toBe("hobo-ci://leases");
		const leases = Leases.parse(
			Text.parse(await client.callTool({ name: "list_leases", arguments: {} }))
				.structuredContent,
		);
		expect(leases.leases[0]?.state).toBe("dispatching");
	});
});

/** One JSON-RPC request as a test writes it. */
type RpcMessage = Readonly<{
	jsonrpc: string;
	id: number;
	method: string;
	params?: JsonObject;
}>;

/** A JSON-RPC request, or a batch of them, as one POST of one credential. */
function rpc(
	h: Awaited<ReturnType<typeof setup>>,
	authorization: string,
	body: RpcMessage | readonly RpcMessage[],
	headers: Record<string, string> = {},
	signal?: AbortSignal,
) {
	const request = post(JSON.stringify(body), { authorization, ...headers });
	return h.handle(signal ? new Request(request, { signal }) : request);
}
const call = (
	id: number,
	name: string,
	input: JsonObject = {},
): RpcMessage => ({
	jsonrpc: "2.0",
	id,
	method: "tools/call",
	params: { name, arguments: input },
});
const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "raw", version: "1.0.0" },
	},
};
/** Open a session by hand and return its id, leaving no stream behind. */
async function openSession(
	h: Awaited<ReturnType<typeof setup>>,
	authorization: string,
) {
	const response = await rpc(h, authorization, INITIALIZE);
	await response.body?.cancel();
	return {
		status: response.status,
		id: response.headers.get("mcp-session-id"),
	};
}
const Answers = z.array(
	z.object({
		id: z.number(),
		result: z.object({
			isError: z.boolean().optional(),
			content: z.array(z.object({ text: z.string() })),
		}),
	}),
);
/** Journal rows of another account: the neighbour's volume. */
async function neighbourWrites(
	h: Awaited<ReturnType<typeof setup>>,
	count: number,
) {
	for (let index = 0; index < count; index++)
		await h.store.putControlRecord(`n:${index}`, "account-b", "{}", NOW);
}

describe("relay MCP bounds on one caller's work", () => {
	it("hands the event loop back on every pass of a wait that is catching up", async () => {
		let clock = 0;
		const h = await setup({
			sessions: "none",
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		// The account's own journal is long, and none of it is what is waited for.
		for (let index = 0; index < 2_600; index++)
			await h.store.putControlRecord(`note:${index}`, "account-a", "{}", NOW);
		const a = await h.connect(h.tokens.a.authorization);
		// Something else that needs the event loop: it must keep getting turns.
		let ticks = 0;
		let waiting = true;
		const tick = () => {
			ticks += 1;
			if (waiting) setImmediate(tick);
		};
		const before = h.journalReads();
		setImmediate(tick);
		const waited = Events.parse(
			(
				await a.client.callTool({
					name: "wait_for_events",
					arguments: {
						cursor: "0",
						types: ["ci.LeaseCancelled"],
						timeoutSeconds: 2,
					},
				})
			).structuredContent,
		);
		waiting = false;
		const reads = h.journalReads() - before;
		// Six reads to reach the end of the journal, then one a second.
		expect(reads).toBe(8);
		expect(ticks).toBeGreaterThanOrEqual(reads);
		expect(waited).toMatchObject({ events: [], timedOut: true, more: false });
	});

	it("bounds the reads of one wait, and sees its caller leave between them", async () => {
		let passes = 0;
		const hangUp = new AbortController();
		const h = await setup({
			sessions: "none",
			now: () => 0,
			sleep: async () => {
				throw new Error("a wait that is behind reads on; it does not sleep");
			},
			pause: async () => {
				passes += 1;
				if (hangUp.signal.reason === "at the third pass" && passes === 3)
					hangUp.abort();
				await new Promise((done) => setImmediate(done));
			},
		});
		for (let index = 0; index < 4_600; index++)
			await h.store.putControlRecord(`note:${index}`, "account-a", "{}", NOW);
		const a = await h.connect(h.tokens.a.authorization);
		const wait = {
			cursor: "0",
			types: ["ci.LeaseCancelled"],
			timeoutSeconds: 30,
		};
		const before = h.journalReads();
		const behind = Events.parse(
			(await a.client.callTool({ name: "wait_for_events", arguments: wait }))
				.structuredContent,
		);
		// Still behind after its share of reads: not a timeout, and not the end.
		expect(h.journalReads() - before).toBe(8);
		expect(behind).toMatchObject({ events: [], timedOut: false, more: true });
		// The cursor it hands back continues where it stopped.
		const rest = Events.parse(
			(
				await a.client.callTool({
					name: "wait_for_events",
					arguments: { ...wait, cursor: behind.cursor, timeoutSeconds: 0 },
				})
			).structuredContent,
		);
		expect(rest).toMatchObject({ events: [], more: true });

		// A caller that leaves is noticed at the next pass, not after the work.
		const leaving = new AbortController();
		passes = 0;
		const left = h.journalReads();
		const pending = rpc(
			h,
			h.tokens.a.authorization,
			call(7, "wait_for_events", wait),
			{},
			leaving.signal,
		);
		while (passes < 3) await turns(1);
		leaving.abort();
		expect((await pending).status).toBe(400);
		await turns();
		expect(h.journalReads() - left).toBeLessThan(5);
	});

	it("gives each account its own share of the waits", async () => {
		const sleepers: Array<() => void> = [];
		let clock = 0;
		const h = await setup({
			sessions: "none",
			maxWaits: 5,
			maxWaitsPerAccount: 4,
			now: () => clock,
			sleep: () =>
				new Promise<void>((resolve) => {
					sleepers.push(resolve);
				}),
		});
		await seed(h);
		// One request, five waits: the transport starts them all at once.
		const batch = rpc(
			h,
			h.tokens.a.authorization,
			[1, 2, 3, 4, 5].map((id) => call(id, "wait_for_events")),
		);
		while (sleepers.length < 4) await turns(1);
		await turns();
		// Four are waiting. The fifth was refused: the account has its share.
		expect(sleepers.length).toBe(4);
		// The place the account could not take is there for another account.
		const b = await h.connect(h.tokens.b.authorization);
		const other = await b.call("wait_for_events", { timeoutSeconds: 0 });
		expect(other.isError).toBe(undefined);
		// Past every deadline: each wait wakes, finds nothing and times out.
		clock = 60_000;
		for (const wake of sleepers.splice(0)) wake();
		const answered = batch.then((response) => response.json());
		const answers = Answers.parse(await answered);
		expect(answers.length).toBe(5);
		const refused = answers.filter((answer) => answer.result.isError);
		expect(refused.length).toBe(1);
		expect(refused[0]?.result.content[0]?.text).toMatch(
			/too many callers are waiting/,
		);
	});

	it("bounds the messages of one request and the calls one account has in progress", async () => {
		let open = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const h = await setup(
			{ sessions: "none", maxCallsPerAccount: 2 },
			{ beforeLeaseRead: () => gate },
		);
		await seed(h);
		const pings = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				jsonrpc: "2.0",
				id: index + 1,
				method: "ping",
			}));
		const tooMany = await rpc(h, h.tokens.a.authorization, pings(9));
		expect(tooMany.status).toBe(400);
		expect(await tooMany.json()).toEqual({
			error: "too many JSON-RPC messages in one request; at most 8",
		});
		expect((await rpc(h, h.tokens.a.authorization, pings(8))).status).toBe(200);
		// The cap is on what the transport is given to run, whatever the method
		// and however the body is dressed. A byte-order mark, which one JSON
		// parser rejects and another skips, does not get a batch past the count:
		// the body is parsed once, and what that parse refuses is refused.
		const lists = Array.from({ length: 9 }, (_, index) => ({
			jsonrpc: "2.0",
			id: index + 1,
			method: "tools/list",
		}));
		const authorization = h.tokens.a.authorization;
		const marked = await h.handle(
			post(`\uFEFF${JSON.stringify(lists)}`, { authorization }),
		);
		expect(marked.status).toBe(400);
		expect(await marked.json()).toEqual({ error: "request body is not JSON" });
		expect(
			(await h.handle(post(`\uFEFF${PING}`, { authorization }))).status,
		).toBe(400);
		expect(
			(await h.handle(post(JSON.stringify(lists), { authorization }))).status,
		).toBe(400);
		const within = await h.handle(
			post(JSON.stringify(lists.slice(0, 8)), { authorization }),
		);
		expect(within.status).toBe(200);
		expect(
			z.array(z.object({ id: z.number() })).parse(await within.json()).length,
		).toBe(8);
		for (const body of ["", "{", "[1,2", "\uFFFE"]) {
			const refused = await h.handle(post(body, { authorization }));
			expect(refused.status, body).toBe(400);
			expect(await refused.json(), body).toEqual({
				error: "request body is not JSON",
			});
		}
		const mangled = await h.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				// Not UTF-8 at all.
				body: new Uint8Array([0x5b, 0xff, 0xfe, 0x5d]),
			}),
		);
		expect(mangled.status).toBe(400);
		// Nesting deep enough to exhaust the stack in a walk of the value is a
		// body this parse does not accept, not a failure of the relay.
		const nested = await h.handle(
			post(`${"[".repeat(5000)}${"]".repeat(5000)}`, { authorization }),
		);
		expect(nested.status).toBe(400);
		expect(await nested.json()).toEqual({ error: "request body is not JSON" });
		// A batch far over the cap is refused on its length; its messages,
		// here themselves too deep to walk, are not looked into first.
		const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
		const flooded = await h.handle(
			post(`[${Array.from({ length: 9 }, () => deep).join(",")}]`, {
				authorization,
			}),
		);
		expect(flooded.status).toBe(400);
		expect(await flooded.json()).toEqual({
			error: "too many JSON-RPC messages in one request; at most 8",
		});

		// Four reads in one request, each held at the store.
		const batch = rpc(
			h,
			h.tokens.a.authorization,
			[1, 2, 3, 4].map((id) => call(id, "list_leases")),
		);
		const other = rpc(h, h.tokens.b.authorization, call(9, "list_leases"));
		await turns();
		open();
		const answers = Answers.parse(await (await batch).json());
		// Two ran; two were refused before they reached the store.
		expect(
			answers.map((answer) => answer.result.isError === true).sort(),
		).toEqual([false, false, true, true]);
		expect(
			answers.find((answer) => answer.result.isError)?.result.content[0]?.text,
		).toBe(
			"too many calls in progress for this account; retry when one has finished",
		);
		// Another account's call was never in that queue.
		const theirs = z
			.object({ result: z.object({ isError: z.boolean().optional() }) })
			.parse(await (await other).json());
		expect(theirs.result.isError).toBe(undefined);
		// The places are free again.
		const a = await h.connect(h.tokens.a.authorization);
		expect((await a.call("list_leases")).isError).toBe(undefined);
	});
});

describe("relay MCP journal bounds", () => {
	it("finds an account's events behind a neighbour's volume, and says what it did not read", async () => {
		const h = await setup({
			sessions: "none",
			now: () => 0,
			sleep: async () => {
				throw new Error("a wait that is behind reads on; it does not sleep");
			},
		});
		const { mine } = await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const types = (text: z.infer<typeof Events>) =>
			text.events.map((event) => event.type);

		// A busy neighbour: more rows than the newest-events read used to see.
		await neighbourWrites(h, 1_500);
		const recent = Events.parse(
			(await a.call("list_events")).structuredContent,
		);
		expect(types(recent)).toEqual([
			"ci.JobQueued",
			"ci.JobQueued",
			"ci.LeaseReserved",
		]);
		expect(recent.truncated).toBe(false);

		// Now more than two scans of the journal lie between the account's
		// first events and its next one.
		await neighbourWrites(h, 20_000);
		await h.store.queue(job(9), LATER, h.revision);
		const newest = Events.parse(
			(await a.call("list_events")).structuredContent,
		);
		expect(newest.events.map((event) => event.jobId)).toEqual([9]);
		// Older events exist; the read says it did not look that far back.
		expect(newest.truncated).toBe(true);

		const first = Events.parse(
			(await a.call("list_events", { cursor: "0" })).structuredContent,
		);
		expect(types(first).length).toBe(3);
		expect(first.more).toBe(true);
		// A scan that holds nothing of the account's is not "caught up".
		const empty = Events.parse(
			(await a.call("list_events", { cursor: first.cursor })).structuredContent,
		);
		expect(empty.events).toEqual([]);
		expect(empty.more).toBe(true);
		expect(empty.timedOut).toBe(false);
		const last = Events.parse(
			(await a.call("list_events", { cursor: empty.cursor })).structuredContent,
		);
		expect(last.events.map((event) => event.jobId)).toEqual([9]);
		expect(last.more).toBe(false);

		// A wait reads on through the empty stretch instead of timing out.
		const waited = Events.parse(
			(
				await a.call("wait_for_events", {
					cursor: first.cursor,
					timeoutSeconds: 30,
				})
			).structuredContent,
		);
		expect(waited.events.map((event) => event.jobId)).toEqual([9]);
		expect(waited.timedOut).toBe(false);

		// A lease's events are read by its id, however old they are.
		expect(
			(await a.call("get_lease", { leaseId: mine.id })).structuredContent,
		).toMatchObject({
			events: [{ type: "ci.LeaseReserved", leaseId: mine.id }],
		});
		const resource = await a.read(`hobo-ci://leases/${mine.id}`);
		expect(JSON.parse(resource.contents[0]?.text ?? "")).toMatchObject({
			events: [{ type: "ci.LeaseReserved" }],
		});
		expect(
			JSON.parse((await a.read("hobo-ci://events")).contents[0]?.text ?? ""),
		).toMatchObject({ truncated: true });
	});

	it("moves an account's cursor only with the account's own events", async () => {
		let clock = 0;
		const h = await setup({
			sessions: "none",
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		const { mine, theirs } = await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const cursorOf = async (name: string, input: JsonObject = {}) =>
			Events.parse(
				(await a.client.callTool({ name, arguments: input })).structuredContent,
			);
		const before = await cursorOf("list_events");
		// Another account journals: a lease moves, a job is queued, records change.
		await dispatch(h, theirs);
		await h.store.queue(foreignJob(30), LATER, h.revision);
		await neighbourWrites(h, 25);
		// None of that shows in what this account is handed: the same cursor,
		// from the newest read, from a read after it, and from waits that time out.
		expect((await cursorOf("list_events")).cursor).toBe(before.cursor);
		const idle = await cursorOf("list_events", { cursor: before.cursor });
		expect(idle).toMatchObject({ events: [], cursor: before.cursor });
		expect(
			await cursorOf("wait_for_events", {
				cursor: before.cursor,
				timeoutSeconds: 2,
			}),
		).toMatchObject({ events: [], cursor: before.cursor, timedOut: true });
		expect(
			await cursorOf("wait_for_events", { timeoutSeconds: 2 }),
		).toMatchObject({ events: [], cursor: before.cursor, timedOut: true });
		expect(
			JSON.parse((await a.read("hobo-ci://events")).contents[0]?.text ?? ""),
		).toMatchObject({ cursor: before.cursor });
		// The account's own next event moves it, and nothing was skipped.
		await dispatch(h, mine);
		const next = await cursorOf("list_events", { cursor: before.cursor });
		expect(next.events.map((event) => event.type)).toEqual([
			"ci.DispatchRequested",
		]);
		expect(next.cursor).not.toBe(before.cursor);
		expect((await cursorOf("list_events")).cursor).toBe(next.cursor);
		expect(
			await cursorOf("list_events", { cursor: next.cursor }),
		).toMatchObject({ events: [], cursor: next.cursor });
	});

	it("hands out cursors that say nothing of the journal and work for one account only", async () => {
		const h = await setup({ sessions: "none" });
		await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const b = await h.connect(h.tokens.b.authorization);
		const mine = Events.parse((await a.call("list_events")).structuredContent);
		const theirs = Events.parse(
			(await b.call("list_events")).structuredContent,
		);
		// Both are at the same place in the journal, and neither can tell.
		expect(mine.cursor).toMatch(CURSOR);
		expect(theirs.cursor).toMatch(CURSOR);
		expect(mine.cursor).not.toBe(theirs.cursor);
		expect(
			Events.parse((await a.call("list_events")).structuredContent).cursor,
		).toBe(mine.cursor);
		for (const text of [
			JSON.stringify(mine),
			JSON.stringify(theirs),
			(await a.read("hobo-ci://events")).contents[0]?.text ?? "",
		])
			expect(text).not.toMatch(/"cursor":"\d+"/);

		// Refusing a cursor is the caller's mistake, not the relay's failure:
		// nothing is written to the failure log however often it is repeated.
		const lines: string[] = [];
		const log = vi.spyOn(console, "error").mockImplementation((line) => {
			lines.push(String(line));
		});
		try {
			for (const cursor of [
				// Another account's cursor.
				theirs.cursor,
				// The right look, never issued.
				"AAAAAAAAAAAAAAAAAAAAAA",
				// A journal position, as it once was; one past any safe number.
				"42",
				"9999999999999999",
				"",
			])
				for (const name of ["list_events", "wait_for_events"]) {
					const refused = await a.call(name, { cursor, timeoutSeconds: 0 });
					expect(refused.isError, `${name} ${cursor}`).toBe(true);
					expect(refused.content[0]?.text, `${name} ${cursor}`).toMatch(
						/invalid cursor|Invalid arguments/i,
					);
				}
			expect(lines).toEqual([]);
		} finally {
			log.mockRestore();
		}
		// The documented start still works, as does the account's own cursor.
		expect((await a.call("list_events", { cursor: "0" })).isError).toBe(
			undefined,
		);
		expect((await a.call("list_events", { cursor: mine.cursor })).isError).toBe(
			undefined,
		);
	});
});

describe("relay MCP session shares", () => {
	it("counts the sessions an account is still opening", async () => {
		const h = await setup({ sessions: "memory", maxSessionsPerAccount: 1 });
		const both = await Promise.all([
			openSession(h, h.tokens.a.authorization),
			openSession(h, h.tokens.a.authorization),
		]);
		expect(both.map((opened) => opened.status).sort()).toEqual([200, 429]);
	});

	it("makes room for an account that holds less than its share", async () => {
		let clock = 0;
		const h = await setup({
			sessions: "memory",
			maxSessions: 2,
			maxSessionsPerAccount: 2,
			now: () => clock,
		});
		const ping = (authorization: string, id: string | null) =>
			rpc(
				h,
				authorization,
				{ jsonrpc: "2.0", id: 5, method: "ping" },
				{
					"mcp-session-id": id ?? "",
				},
			);
		// One account takes every place.
		const older = await openSession(h, h.tokens.a.authorization);
		clock = 1_000;
		const newer = await openSession(h, h.tokens.a.authorization);
		expect([older.status, newer.status]).toEqual([200, 200]);
		// Another account is not locked out: the holder's least recently used
		// session gives way.
		clock = 2_000;
		const theirs = await openSession(h, h.tokens.b.authorization);
		expect(theirs.status).toBe(200);
		expect((await ping(h.tokens.a.authorization, older.id)).status).toBe(404);
		expect((await ping(h.tokens.a.authorization, newer.id)).status).toBe(200);
		expect((await ping(h.tokens.b.authorization, theirs.id)).status).toBe(200);
		// Each holds one now: neither may take the other's.
		for (const authorization of [
			h.tokens.a.authorization,
			h.tokens.b.authorization,
		])
			expect((await openSession(h, authorization)).status).toBe(429);
		expect((await ping(h.tokens.a.authorization, newer.id)).status).toBe(200);
		expect((await ping(h.tokens.b.authorization, theirs.id)).status).toBe(200);
	});

	it("lets only an initialize make room, once per cool-down, and only from an account over its share", async () => {
		let clock = 0;
		const h = await setup({
			sessions: "memory",
			maxSessions: 2,
			maxSessionsPerAccount: 2,
			displaceCooldownMs: 60_000,
			now: () => clock,
		});
		const alive = async (authorization: string, id: string | null) => {
			const response = await rpc(
				h,
				authorization,
				{ jsonrpc: "2.0", id: 5, method: "ping" },
				{ "mcp-session-id": id ?? "" },
			);
			await response.body?.cancel();
			return response.status === 200;
		};
		const a = h.tokens.a.authorization;
		const b = h.tokens.b.authorization;
		const first = await openSession(h, a);
		clock = 1_000;
		const second = await openSession(h, a);
		clock = 2_000;

		// A request that is not an initialize opens nothing and costs nobody a
		// place, however often it is sent to a full host.
		for (const body of [
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			[INITIALIZE, { jsonrpc: "2.0", id: 2, method: "ping" }],
		]) {
			const refused = await rpc(h, b, body);
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({
				error: "MCP session required; initialize first",
			});
		}
		// Nor does an initialize the transport refuses: no session, no eviction.
		const malformed = await rpc(h, b, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
		});
		expect(malformed.status).toBe(400);
		await malformed.body?.cancel();
		expect(await alive(a, first.id)).toBe(true);
		expect(await alive(a, second.id)).toBe(true);

		// A real initialize from an account below its share displaces the
		// least recently used session of the account above it.
		clock = 3_000;
		const theirs = await openSession(h, b);
		expect(theirs.status).toBe(200);
		expect(await alive(a, second.id)).toBe(true);
		const firstGone = !(await alive(a, first.id));
		expect(firstGone).toBe(true);

		// Opening and closing in a loop does not keep doing it. The session is
		// ended, its holder opens one again, and the host is full once more...
		const ended = await h.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "DELETE",
				headers: { authorization: b, "mcp-session-id": theirs.id ?? "" },
			}),
		);
		expect(ended.status).toBe(200);
		clock = 4_000;
		const again = await openSession(h, a);
		expect(again.status).toBe(200);
		// ...but the account that displaced a session a moment ago must wait.
		clock = 5_000;
		const soon = await openSession(h, b);
		expect(soon.status).toBe(429);
		expect(await alive(a, second.id)).toBe(true);
		expect(await alive(a, again.id)).toBe(true);
		clock = 64_000;
		expect((await openSession(h, b)).status).toBe(200);
	});

	it("displaces nobody for an account when no holder is over its share", async () => {
		const h = await setup({
			sessions: "memory",
			maxSessions: 2,
			maxSessionsPerAccount: 2,
		});
		const mine = await openSession(h, h.tokens.a.authorization);
		const theirs = await openSession(h, h.tokens.b.authorization);
		expect([mine.status, theirs.status]).toEqual([200, 200]);
		// Two places, two accounts with one each: neither holds more than its
		// share, so neither gives a place up to the other.
		expect((await openSession(h, h.tokens.a.authorization)).status).toBe(429);
		expect((await openSession(h, h.tokens.b.authorization)).status).toBe(429);
		for (const [authorization, id] of [
			[h.tokens.a.authorization, mine.id],
			[h.tokens.b.authorization, theirs.id],
		] as const) {
			const response = await rpc(
				h,
				authorization,
				{ jsonrpc: "2.0", id: 5, method: "ping" },
				{ "mcp-session-id": id ?? "" },
			);
			await response.body?.cancel();
			expect(response.status).toBe(200);
		}
	});

	it("lets every agent an account may connect wait at once, without taking its calls", async () => {
		const sleepers: Array<() => void> = [];
		let clock = 0;
		const h = await setup({
			sessions: "memory",
			now: () => clock,
			sleep: () =>
				new Promise<void>((resolve) => {
					sleepers.push(resolve);
				}),
		});
		await seed(h);
		const authorization = h.tokens.a.authorization;
		// As many sessions as one account may hold, each following the journal.
		const sessions: string[] = [];
		for (let agent = 0; agent < 8; agent++) {
			const opened = await openSession(h, authorization);
			expect(opened.status).toBe(200);
			sessions.push(opened.id ?? "");
		}
		expect((await openSession(h, authorization)).status).toBe(429);
		const waiting = await Promise.all(
			sessions.map((id, agent) =>
				rpc(h, authorization, call(agent + 1, "wait_for_events"), {
					"mcp-session-id": id,
				}),
			),
		);
		while (sleepers.length < 8) await turns(1);
		// All eight are parked; none was refused.
		expect(sleepers.length).toBe(8);
		// A wait holds no place a call needs: each agent can still ask.
		const asked = await rpc(h, authorization, call(50, "list_leases"), {
			"mcp-session-id": sessions[0] ?? "",
		});
		expect(await asked.text()).not.toMatch(/too many/);
		// A ninth wait is one more than the account has agents.
		const ninth = await rpc(h, authorization, call(51, "wait_for_events"), {
			"mcp-session-id": sessions[0] ?? "",
		});
		expect(await ninth.text()).toMatch(/too many callers are waiting/);
		clock = 60_000;
		for (const wake of sleepers.splice(0)) wake();
		for (const response of waiting)
			expect(await response.text()).toMatch(/timedOut\\?":true/);
	});

	it("closes an event stream that has been open for its lifetime", async () => {
		let clock = 0;
		const h = await setup({
			sessions: "memory",
			streamMaxMs: 60_000,
			sessionIdleMs: 30_000,
			now: () => clock,
		});
		const { id } = await openSession(h, h.tokens.a.authorization);
		const session = { "mcp-session-id": id ?? "" };
		const stream = await h.handle(
			new Request(`${ORIGIN}/mcp`, {
				headers: {
					authorization: h.tokens.a.authorization,
					accept: "text/event-stream",
					...session,
				},
			}),
		);
		expect(stream.status).toBe(200);
		const reader = stream.body?.getReader();
		const ping = async () => {
			const response = await rpc(
				h,
				h.tokens.a.authorization,
				{ jsonrpc: "2.0", id: 5, method: "ping" },
				session,
			);
			await response.body?.cancel();
			return response.status;
		};
		// A listening session is not idle, however long it makes no request.
		clock = 59_000;
		expect(await ping()).toBe(200);
		let ended = false;
		const end = reader?.read().then((chunk) => {
			ended = chunk.done;
		});
		await turns();
		expect(ended).toBe(false);
		// At its lifetime the server ends the stream; the client opens another.
		clock = 60_000;
		expect(await ping()).toBe(200);
		await end;
		expect(ended).toBe(true);
		// Left without a stream and without a request, the session idles out.
		clock = 91_000;
		expect(await ping()).toBe(404);
	});

	it("backs the pump off while the store fails, and asks once per pass", async () => {
		const slept: number[] = [];
		const sleepers: Array<() => void> = [];
		let failing = false;
		const h = await setup(
			{
				sessions: "memory",
				pollMs: 1_000,
				sleep: (ms, signal) =>
					new Promise<void>((resolve) => {
						slept.push(ms);
						sleepers.push(resolve);
						signal.addEventListener("abort", () => resolve(), { once: true });
					}),
			},
			{
				beforeJournalRead: async () => {
					if (failing) throw new Error("store unavailable");
				},
			},
		);
		await seed(h);
		const a = await h.connect(h.tokens.a.authorization);
		const b = await h.connect(h.tokens.b.authorization);
		await a.client.subscribeResource({ uri: "hobo-ci://events" });
		await b.client.subscribeResource({ uri: "hobo-ci://events" });
		const pass = async () => {
			while (sleepers.length === 0) await turns(1);
			const reads = h.journalReads();
			for (const wake of sleepers.splice(0)) wake();
			while (sleepers.length === 0) await turns(1);
			return h.journalReads() - reads;
		};
		const lines: string[] = [];
		const log = vi.spyOn(console, "error").mockImplementation((line) => {
			lines.push(String(line));
		});
		try {
			// Healthy: both subscribed accounts are read each pass.
			expect(await pass()).toBe(2);
			failing = true;
			slept.length = 0;
			const attempts = [await pass(), await pass(), await pass(), await pass()];
			// One read per pass: the next account would fail the same way.
			expect(attempts).toEqual([1, 1, 1, 1]);
			expect(slept).toEqual([2_000, 4_000, 8_000, 16_000]);
			// The failure log writes one line for the outage, not one per pass.
			expect(
				lines.filter((line) => line.includes("hobo_ci_mcp_pump_failed")).length,
			).toBeLessThanOrEqual(1);
			failing = false;
			slept.length = 0;
			expect(await pass()).toBe(2);
			expect(slept).toEqual([1_000]);
		} finally {
			log.mockRestore();
		}
	});
});
