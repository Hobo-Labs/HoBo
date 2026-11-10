import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { create } from "@bufbuild/protobuf";
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
import { afterEach, describe, expect, it } from "vitest";
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
	cursor: z.string(),
	type: z.string(),
	at: z.string(),
	leaseId: z.string(),
	state: z.string(),
	repository: z.string(),
	jobId: z.number(),
});
const Events = z.object({
	events: z.array(EventView),
	cursor: z.string(),
	timedOut: z.boolean(),
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

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function setup(
	overrides: Partial<RelayMcpOptions> & Pick<RelayMcpOptions, "sessions">,
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
			accountLeases: (accountId) => store.accountLeases(accountId),
			pendingJobs: () => store.pendingJobs(),
			quarantinedWebhooks: (accountId, expected) =>
				store.quarantinedWebhooks(accountId, expected),
			retryQuarantinedWebhook: (accountId, expected, deliveryId) =>
				store.retryQuarantinedWebhook(accountId, expected, deliveryId),
			eventsSince: (cursor) => {
				journalReads++;
				return store.eventsSince(cursor);
			},
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
		expect(Number(next.cursor)).toBeGreaterThan(Number(newest.cursor));
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
		expect(Number(idle.cursor)).toBeGreaterThan(0);
		const capped = time.now();
		await a.call("wait_for_events", { timeoutSeconds: 3600 });
		expect(time.now() - capped).toBe(50_000);
		const instant = time.slept.length;
		await a.call("wait_for_events", { timeoutSeconds: 0 });
		expect(time.slept.length).toBe(instant);
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
		// The abandoned wait gave its place back.
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
		await new Promise((done) => setImmediate(done));
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
