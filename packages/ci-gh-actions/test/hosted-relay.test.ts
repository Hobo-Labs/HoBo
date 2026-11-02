import { clone } from "@bufbuild/protobuf";
import { ConfigurationSchema, OfferSchema } from "@hobo/ci";
import { afterEach, expect, it } from "vitest";
import { HostedRelay, type HostedRelayStore } from "../src/hosted-relay.js";
import {
	createHostedRelayRuntime,
	type HostedInboxStore,
} from "../src/hosted-runtime.js";
import { harness, job, NOW, queued, SECRET, signed } from "./fixtures.js";

const fixtures: ReturnType<typeof harness>[] = [];
function setup() {
	const h = harness();
	fixtures.push(h);
	h.store.configure(h.configuration, 0, NOW);
	const revision = (expected?: number) => {
		if (
			expected !== undefined &&
			h.store.configuration()?.revision !== expected
		)
			throw new Error("configuration revision conflict");
	};
	const store: HostedRelayStore = {
		async configuration() {
			return h.store.configuration();
		},
		async policySnapshot() {
			const state = h.store.configuration();
			const policies = (state?.configuration?.accounts ?? []).flatMap(
				(account) => {
					const record = h.store.controlRecord(`ci-policy:${account.id}`);
					return record
						? [{ accountId: account.id, bodyJson: record.bodyJson }]
						: [];
				},
			);
			return { state, policies };
		},
		async get(id) {
			return h.store.get(id);
		},
		async all() {
			return h.store.all();
		},
		async activeLeases() {
			return h.store
				.all()
				.filter((lease) =>
					[
						"reserved",
						"dispatching",
						"dispatched",
						"claiming",
						"running",
						"uncertain",
					].includes(lease.state),
				);
		},
		async accountLeases(accountId) {
			return h.store.all().filter((lease) => lease.accountId === accountId);
		},
		async pendingJobs() {
			return h.store.pendingJobs();
		},
		async observe(job, at, expected) {
			revision(expected);
			h.store.observe(job, at);
		},
		async queue(job, at, expected) {
			revision(expected);
			h.store.queue(job, at);
		},
		async reserve(account, job, at, expected) {
			revision(expected);
			return h.store.reserve(account, job, at);
		},
		async transition(id, expected, update, event, at, expectedRevision) {
			revision(expectedRevision);
			return h.store.transition(id, expected, update, event, at);
		},
		async cancelAndRequeue(id, job, at) {
			h.store.cancelAndRequeue(id, job, at);
		},
		async abortIsolatedAndRequeue(id, job, at) {
			h.store.abortIsolatedAndRequeue(id, job, at);
		},
		async settleObserved(id, host, minutes, at, unmet, complete, observed) {
			const current = h.store.get(id);
			if (
				!current ||
				current.state !== observed.state ||
				current.hostRunId !== observed.hostRunId ||
				current.runnerId !== observed.runnerId
			)
				return undefined;
			return h.store.settle(id, host, minutes, at, unmet, complete);
		},
	};
	const relay = new HostedRelay({
		config: h.configuration,
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		now: () => h.clock.now,
	});
	return { ...h, relay, asyncStore: store };
}
afterEach(() => {
	for (const h of fixtures.splice(0)) {
		h.store.close();
		expect(h.api.violations).toEqual([]);
	}
});
async function reserve(h: ReturnType<typeof setup>) {
	const request = signed(queued());
	const result = await h.relay.webhook(
		request.body,
		request.signature,
		"workflow_job",
	);
	const lease = h.store.all().find((entry) => entry.jobId === 1);
	if (!lease) throw new Error(`missing lease: ${result}`);
	h.api.leaseId = lease.id;
	h.api.host.display_title = `HoBo lease ${lease.id}`;
	return lease;
}

it("requeues a paid reservation when a partial free host becomes available", async () => {
	const h = setup();
	const account = h.configuration.accounts[0];
	const paid = account?.offers[0];
	if (!account || !paid) throw new Error("missing offer");
	paid.freeMinutes = 0;
	paid.priceMicrosPerMinute = 1;
	paid.observedAt = "2026-10-26T11:00:00Z";
	h.store.configure(h.configuration, 1, NOW);
	const original = await reserve(h);
	const free = clone(OfferSchema, paid);
	free.id = "partial-free";
	free.providerAccountId = "another-account";
	free.freeMinutes = 1;
	free.priceMicrosPerMinute = 1000;
	account.offers.push(free);
	h.store.configure(h.configuration, 2, NOW);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(original.id)?.state).toBe("cancelled");
	expect(h.store.pendingJobs()).toHaveLength(1);
	h.api.strictLeaseId = false;
	h.api.hostLabel = free.runsOn;
	await h.relay.dispatchPending();
	expect(h.store.all().find((entry) => entry.id !== original.id)).toMatchObject(
		{
			offerId: free.id,
			state: "dispatched",
		},
	);
});

it("reserves newly measured free minutes on the same unlaunched host", async () => {
	const h = setup();
	const offer = h.configuration.accounts[0]?.offers[0];
	if (!offer) throw new Error("missing offer");
	offer.freeMinutes = 0;
	offer.observedAt = "2026-10-26T11:00:00Z";
	h.store.configure(h.configuration, 1, NOW);
	const original = await reserve(h);
	offer.freeMinutes = 1;
	offer.observedAt = "2026-10-26T11:30:00Z";
	h.store.configure(h.configuration, 2, NOW);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(original.id)?.state).toBe("cancelled");
	h.api.strictLeaseId = false;
	await h.relay.dispatchPending();
	expect(h.store.all().find((entry) => entry.id !== original.id)).toMatchObject(
		{
			offerId: offer.id,
			reservedFreeMinutes: 1,
			state: "dispatched",
		},
	);
	const replacement = h.store.all().find((entry) => entry.id !== original.id);
	offer.freeMinutes = 2;
	offer.observedAt = "2026-10-26T11:45:00Z";
	h.store.configure(h.configuration, 3, NOW);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	expect(h.store.get(replacement?.id ?? "")?.state).toBe("dispatched");
});

function setIsolatedOnly(h: ReturnType<typeof setup>, duringLease = false) {
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("fixture connection");
	connection.isolatedOnly = true;
	connection.acceptAllMatchingRepositoryJobs = true;
	connection.publicRepositoryAcknowledged = true;
	connection.allowedEvents = [];
	connection.allowedRefs = [];
	connection.bridgeWorkflow = "";
	connection.bridgeRef = "";
	connection.bridgeSha = "";
	connection.dispatcherActorId = 0;
	if (duringLease) {
		// Exercise a concurrent authority change defensively even though the
		// current store prevents changing bindings while leases are active.
		const state = h.store.configuration();
		if (!state) throw new Error("fixture configuration");
		h.asyncStore.policySnapshot = async () => ({
			state: { ...state, configuration: h.configuration },
			policies: [],
		});
	} else h.store.configure(h.configuration, 1, NOW);
}

it("requires isolated execution for private push jobs on isolated-only connections", async () => {
	const h = setup();
	setIsolatedOnly(h);
	h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("waiting-for-budget-or-capacity");
	expect(h.store.pendingJobs()).toMatchObject([{ isolatedRequired: true }]);
	await h.relay.dispatchPending();
	expect(h.store.all()).toEqual([]);
	expect(h.api.dispatches).toBe(0);
});

it("fails closed without an isolated host for an isolated-only connection", async () => {
	const h = setup();
	setIsolatedOnly(h);
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("ignored");
	expect(h.store.pendingJobs()).toEqual([]);
});

it("rechecks isolation for demand queued before the connection changed", async () => {
	const h = setup();
	h.store.queue(job(), NOW);
	setIsolatedOnly(h);
	h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	await h.relay.dispatchPending();
	expect(h.store.all()).toEqual([]);
	expect(h.api.dispatches).toBe(0);
});

it("cancels and requeues a bridge reservation after isolation becomes required", async () => {
	const h = setup();
	const lease = await reserve(h);
	setIsolatedOnly(h, true);
	h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	await h.relay.dispatchPending();
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
	expect(h.store.pendingJobs()).toMatchObject([{ isolatedRequired: true }]);
	expect(h.api.dispatches).toBe(0);
});

it("does not claim an already dispatched bridge after isolation becomes required", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	setIsolatedOnly(h, true);
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(
		"workflow bridge disabled for isolated connection",
	);
	expect(h.api.registrations).toBe(0);
});

it("admits a fork PR under universal isolated consent even when GitHub omits its PR list", async () => {
	const h = setup();
	setIsolatedOnly(h);
	h.api.original.event = "pull_request";
	h.api.original.repository.private = false;
	h.api.original.head_repository.id = 999;
	h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("waiting-for-budget-or-capacity");
	expect(h.store.pendingJobs()).toMatchObject([{ isolatedRequired: true }]);
});

it.each([
	"schedule",
	"release",
	"pull_request_target",
	"workflow_call",
])("admits any %s event without branch restrictions under universal consent", async (event) => {
	const h = setup();
	setIsolatedOnly(h);
	h.api.original.event = event;
	h.api.original.head_branch = "untrusted";
	h.api.original.head_repository.id = 999;
	h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("waiting-for-budget-or-capacity");
	expect(h.store.pendingJobs()).toMatchObject([{ isolatedRequired: true }]);
});

it.each([
	"no universal consent",
	"no public acknowledgement",
	"restricted event",
	"restricted branch",
	"selective PR flag",
])("does not admit an invalid isolated policy with %s", async (caseName) => {
	const h = setup();
	setIsolatedOnly(h);
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("fixture connection");
	if (caseName === "no universal consent")
		connection.acceptAllMatchingRepositoryJobs = false;
	if (caseName === "no public acknowledgement")
		connection.publicRepositoryAcknowledged = false;
	if (caseName === "restricted event") connection.allowedEvents = ["push"];
	if (caseName === "restricted branch")
		connection.allowedRefs = ["refs/heads/main"];
	if (caseName === "selective PR flag") connection.allowAllPullRequests = true;
	const state = h.store.configuration();
	if (!state) throw new Error("fixture configuration");
	h.asyncStore.policySnapshot = async () => ({
		state: { ...state, configuration: h.configuration },
		policies: [],
	});
	h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("ignored");
	expect(h.store.pendingJobs()).toEqual([]);
});

it.each([
	"no-opt-in",
	"no-host",
	"no-event",
	"no-public-ack",
	"wrong-repository",
])("denies an all-PR grant without %s", async (missing) => {
	const h = setup();
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("fixture connection");
	connection.allowedEvents =
		missing === "no-event" ? ["push"] : ["pull_request"];
	connection.allowAllPullRequests = missing !== "no-opt-in";
	connection.publicRepositoryAcknowledged = missing !== "no-public-ack";
	h.store.configure(h.configuration, 1, NOW);
	h.api.original.event = "pull_request";
	h.api.original.repository.private = false;
	if (missing === "wrong-repository") h.api.original.repository.id = 999;
	if (missing !== "no-host")
		h.relay.options.isolatedHost = { async launch() {}, async reconcile() {} };
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("ignored");
	expect(h.store.pendingJobs()).toEqual([]);
});

it.each([
	"dispatching",
	"dispatched",
	"claiming",
	"running",
] as const)("force-stops %s sandbox leases through a recovery-only host", async (state) => {
	const h = setup();
	const lease = await reserve(h);
	h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.provider = "vercel";
			entry.sandboxName = `hobo-${lease.id}`;
			entry.state = state;
		},
		"ci.SandboxCreated",
		NOW,
	);
	const store: HostedInboxStore = {
		...h.asyncStore,
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async claimWebhook() {
			return undefined;
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ackWebhook() {
			return true;
		},
		async failWebhook() {
			return "retry";
		},
	};
	const calls: Array<{ id: string; forceStop?: boolean }> = [];
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
		isolatedRecoveryHost: {
			async reconcile(id, forceStop) {
				calls.push({ id, forceStop });
			},
		},
	});
	await runtime.tick();
	expect(calls).toEqual([{ id: lease.id, forceStop: true }]);
});

it("does not accelerate recovery of an in-flight workflow bridge", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.state = "dispatching";
		},
		"ci.DispatchRequested",
		NOW,
	);
	const store: HostedInboxStore = {
		...h.asyncStore,
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async claimWebhook() {
			return undefined;
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ackWebhook() {
			return true;
		},
		async failWebhook() {
			return "retry";
		},
	};
	const calls: string[] = [];
	const request = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method, body) => {
		calls.push(path);
		return request(installation, path, method, body);
	};
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
		isolatedRecoveryHost: {
			async reconcile() {
				throw new Error("unexpected sandbox recovery");
			},
		},
	});
	await runtime.tick();
	expect(calls).toEqual([]);
	expect(h.store.get(lease.id)?.state).toBe("dispatching");
});

it.each([
	["dispatching", "ci.DispatchRequested"],
	["dispatched", "ci.SandboxCreated"],
	["claiming", "ci.RunnerClaimed"],
])("recovers abandoned sandbox %s only after the function deadline", async (state, event) => {
	const h = setup();
	const lease = await reserve(h);
	h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.provider = "vercel";
			entry.sandboxName = `hobo-${lease.id}`;
			entry.state = state;
		},
		event,
		NOW,
	);
	const store: HostedInboxStore = {
		...h.asyncStore,
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((item) => ids.includes(item.leaseId));
		},
		async claimWebhook() {
			return undefined;
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ackWebhook() {
			return true;
		},
		async failWebhook() {
			return "retry";
		},
	};
	let now = new Date(Date.parse(NOW) + 800_000).toISOString();
	const reconciliations: Array<{ id: string; forceStop?: boolean }> = [];
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => now,
		isolatedHost: {
			async launch() {},
			async reconcile(id, forceStop) {
				reconciliations.push({ id, forceStop });
			},
		},
	});
	await runtime.tick();
	expect(h.store.get(lease.id)?.state).toBe(state);
	expect(reconciliations.some((item) => item.forceStop)).toBe(false);
	now = new Date(Date.parse(NOW) + 1_021_000).toISOString();
	await runtime.tick();
	expect(h.store.get(lease.id)?.state).toBe("uncertain");
	expect(reconciliations.at(-1)).toEqual({ id: lease.id, forceStop: true });
});
it("attributes delayed job completion to the job's own attempt after a rerun starts", async () => {
	const h = setup();
	h.api.original.run_attempt = 2;
	h.api.jobStatus = "completed";
	const seen: number[] = [];
	const observe = h.asyncStore.observe.bind(h.asyncStore);
	h.asyncStore.observe = async (job, at, revision) => {
		seen.push(job.runAttempt);
		await observe(job, at, revision);
	};
	const webhook = queued();
	const body = Buffer.from(
		JSON.stringify({
			...webhook,
			action: "completed",
			workflow_job: { ...webhook.workflow_job, run_attempt: undefined },
		}),
	);
	expect(await h.relay.processWebhook(body, "workflow_job")).toBe("ignored");
	expect(seen).toEqual([1]);
});
it("records the fresh completed job when a queued webhook arrives late", async () => {
	const h = setup();
	h.api.jobStatus = "completed";
	const seen: string[] = [];
	const observe = h.asyncStore.observe.bind(h.asyncStore);
	h.asyncStore.observe = async (job, at, revision) => {
		seen.push(job.action);
		await observe(job, at, revision);
	};
	expect(
		await h.relay.processWebhook(
			Buffer.from(JSON.stringify(queued())),
			"workflow_job",
		),
	).toBe("ignored");
	expect(seen).toEqual(["completed"]);
	expect(h.store.all()).toHaveLength(0);
	// A terminal observation fences a subsequent stale queue attempt.
	h.store.queue(job(), NOW);
	expect(h.store.pendingJobs()).toHaveLength(0);
});
it("does not record a terminal event from a stale webhook while GitHub reports waiting", async () => {
	const h = setup();
	h.api.jobStatus = "waiting";
	const seen: string[] = [];
	const observe = h.asyncStore.observe.bind(h.asyncStore);
	h.asyncStore.observe = async (entry, at, revision) => {
		seen.push(entry.action);
		await observe(entry, at, revision);
	};
	const completed = { ...queued(), action: "completed" };
	expect(
		await h.relay.processWebhook(
			Buffer.from(JSON.stringify(completed)),
			"workflow_job",
		),
	).toBe("ignored");
	expect(seen).toEqual([]);
	// The skipped stale event must not install a terminal tombstone.
	h.store.queue(job(), NOW);
	expect(h.store.pendingJobs()).toHaveLength(1);
});
it("records an in-progress observation when an older completed webhook arrives", async () => {
	const h = setup();
	h.api.jobStatus = "in_progress";
	const seen: string[] = [];
	const observe = h.asyncStore.observe.bind(h.asyncStore);
	h.asyncStore.observe = async (entry, at, revision) => {
		seen.push(entry.action);
		await observe(entry, at, revision);
	};
	const completed = { ...queued(), action: "completed" };
	expect(
		await h.relay.processWebhook(
			Buffer.from(JSON.stringify(completed)),
			"workflow_job",
		),
	).toBe("ignored");
	expect(seen).toEqual(["in_progress"]);
	h.store.queue(job(), NOW);
	expect(h.store.pendingJobs()).toHaveLength(1);
});
it("retains a delivery for retry when GitHub omits the job attempt", async () => {
	const h = setup();
	const request = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method, body) => {
		if (path === "/repos/org/repo/actions/jobs/1")
			return Response.json({
				id: 1,
				run_id: 11,
				status: "queued",
				labels: ["hobo"],
			});
		return request(installation, path, method, body);
	};
	await expect(
		h.relay.processWebhook(
			Buffer.from(JSON.stringify(queued())),
			"workflow_job",
		),
	).rejects.toThrow();
	expect(h.store.all()).toHaveLength(0);
});
it("does not dispatch an old reservation after a newer workflow attempt starts", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.api.original.run_attempt = 2;
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});
it("denies workflow bridge admission when unisolated execution is gated", async () => {
	const h = setup();
	h.relay.options.denyUnisolated = true;
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("ignored");
	expect(h.store.all()).toHaveLength(0);
});
it("cancels an existing bridge reservation without dispatch when execution is gated", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.relay.options.denyUnisolated = true;
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});
it("refuses an already-dispatched bridge claim before JIT registration when execution is gated", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	h.relay.options.denyUnisolated = true;
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(
		"original workflow authority revoked",
	);
	expect(h.api.registrations).toBe(0);
});
it("runs a durable async reservation through provider dispatch, JIT and settlement", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(1);
	expect(h.store.get(lease.id)?.state).toBe("dispatched");
	expect(await h.relay.claim(lease.id, "valid")).toMatchObject({
		encodedJitConfig: "c2VjcmV0",
	});
	h.api.host.status = "completed";
	h.api.jobStatus = "completed";
	await h.relay.reconcile(lease.id, 22);
	expect(h.store.get(lease.id)).toMatchObject({
		state: "completed",
		runnerId: 42,
		billedMinutes: 1,
	});
	expect(h.api.registrations).toBe(1);
	expect(h.api.deletes).toBe(1);
});
it("preserves ambiguous dispatch reservations and never repeats the provider request", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.api.uncertain = true;
	await h.relay.dispatchPending();
	await h.relay.dispatchPending();
	expect(h.store.get(lease.id)?.state).toBe("uncertain");
	expect(h.api.dispatches).toBe(1);
});
it("never settles when a concurrent JIT claim starts during host verification", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.host.status = "completed";
	const request = h.api.request.bind(h.api);
	h.api.request = async (installation, path, method, body) => {
		const result = await request(installation, path, method, body);
		if (path === "/repos/org/repo/actions/jobs/1") {
			h.store.transition(
				lease.id,
				["dispatched"],
				(entry) => {
					entry.state = "claiming";
					entry.hostRunId = 22;
				},
				"ci.RunnerClaimed",
				NOW,
			);
		}
		return result;
	};
	await h.relay.reconcile(lease.id, 22);
	expect(h.store.get(lease.id)).toMatchObject({
		state: "claiming",
		hostRunId: 22,
	});
});
it("retains an uncertain registration when its runner ID is unknown", async () => {
	const h = setup();
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.store.transition(
		lease.id,
		["dispatched"],
		(entry) => {
			entry.state = "uncertain";
			entry.hostRunId = 22;
		},
		"ci.LeaseUncertain",
		NOW,
	);
	await expect(h.relay.reconcile(lease.id, 22)).rejects.toThrow(
		"runner registration outcome is unresolved",
	);
	expect(h.store.get(lease.id)?.state).toBe("uncertain");
});
function desiredPolicy(enabled: boolean, blockedByThreshold = false) {
	return JSON.stringify({
		accountId: "account-a",
		tenantId: "tenant-a",
		pool: { label: "hobo", os: "linux", architecture: "x64" },
		budget: {
			scope: "ci-account",
			currency: "USD",
			limitMicros: 1000000,
			period: "manual",
			timeZone: "UTC",
		},
		routing: {
			strategy: "lowest-total-incremental-cost",
			noEligibleProvider: "queue",
			unknownAllocation: "zero",
		},
		providers: [
			{
				id: "blacksmith-a",
				kind: "blacksmith",
				connectionRef: "owned-blacksmith-account",
				runsOn: "blacksmith-2vcpu-ubuntu-2404",
				enabled,
			},
		],
		thresholds: blockedByThreshold ? [{ fraction: 0.8, allow: [] }] : [],
	});
}
it("honors a disabled SDK provider before reserving or dispatching", async () => {
	const h = setup();
	h.store.putControlRecord(
		"ci-policy:account-a",
		"account-a",
		desiredPolicy(false),
		NOW,
	);
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("waiting-for-budget-or-capacity");
	await h.relay.dispatchPending();
	expect(h.store.all()).toHaveLength(0);
	expect(h.api.dispatches).toBe(0);
});
it("applies an active budget threshold again after a lease is reserved", async () => {
	const h = setup();
	const lease = await reserve(h);
	const next = clone(ConfigurationSchema, h.configuration);
	const account = next.accounts[0];
	if (!account) throw new Error("fixture");
	account.routingSignalCrossed["broker:tenant-a:0.8"] = true;
	account.routingSignalCycles["broker:tenant-a:0.8"] = 1;
	h.store.putControlRecord(
		"ci-policy:account-a",
		"account-a",
		desiredPolicy(true, true),
		NOW,
	);
	h.store.configure(next, 1, NOW);
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});
it("rejects a stale policy revision before dispatch when trust changes during a store await", async () => {
	const h = setup();
	const initial = h.configuration.connections[0];
	if (!initial) throw new Error("fixture");
	initial.allowedRefs.push("refs/heads/other");
	h.store.configure(h.configuration, 1, NOW);
	const lease = await reserve(h);
	let changed = false;
	const active = h.asyncStore.activeLeases.bind(h.asyncStore);
	h.asyncStore.activeLeases = async () => {
		const values = await active();
		if (!changed) {
			changed = true;
			const next = clone(ConfigurationSchema, h.configuration);
			const connection = next.connections[0];
			if (!connection) throw new Error("fixture");
			connection.allowedRefs = ["refs/heads/other"];
			h.store.configure(next, 2, NOW);
		}
		return values;
	};
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});
it("fences dispatch when policy changes after preflight and before transactional transition", async () => {
	const h = setup();
	const initial = h.configuration.connections[0];
	if (!initial) throw new Error("fixture");
	initial.allowedRefs.push("refs/heads/other");
	h.store.configure(h.configuration, 1, NOW);
	const lease = await reserve(h);
	const transition = h.asyncStore.transition.bind(h.asyncStore);
	h.asyncStore.transition = async (
		id,
		expected,
		update,
		event,
		at,
		expectedRevision,
	) => {
		if (event === "ci.DispatchRequested") {
			const next = clone(ConfigurationSchema, h.configuration);
			const connection = next.connections[0];
			if (!connection) throw new Error("fixture");
			connection.allowedRefs = ["refs/heads/other"];
			h.store.configure(next, 2, NOW);
		}
		return transition(id, expected, update, event, at, expectedRevision);
	};
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("reserved");
	await h.relay.dispatchPending();
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});

it("durably records signed delivery before a bounded worker launches a host", async () => {
	const h = setup();
	let accepted = false;
	let pending = false;
	let acknowledged = false;
	let ignored = false;
	let stored = new Uint8Array();
	const store: HostedInboxStore = {
		...h.asyncStore,
		async acceptIgnoredWebhook(input) {
			expect(input.deliveryId).toBe("ignored-delivery");
			ignored = true;
			return { duplicate: false };
		},
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async acceptWebhook(input) {
			if (accepted) return { duplicate: true };
			accepted = true;
			pending = true;
			stored = input.rawBody;
			return { duplicate: false };
		},
		async claimWebhook() {
			if (!pending) return undefined;
			pending = false;
			return {
				deliveryId: "delivery",
				event: "workflow_job",
				rawBody: stored,
				token: "owned",
			};
		},
		async ackWebhook(id, token) {
			expect(id).toBe("delivery");
			expect(token).toBe("owned");
			acknowledged = true;
			return true;
		},
		async failWebhook() {
			pending = true;
			return "retry";
		},
	};
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
	});
	const payload = signed(queued());
	const input = {
		deliveryId: "delivery",
		event: "workflow_job" as const,
		rawBody: payload.body,
		receivedAt: NOW,
	};
	expect(await runtime.ready()).toBe(true);
	expect(
		await runtime.ingestWebhook({
			...input,
			deliveryId: "ignored-delivery",
			rawBody: Buffer.from(
				JSON.stringify({
					installation: { id: 999 },
					repository: { id: 999, full_name: "unknown/repo" },
				}),
			),
		}),
	).toBe("ignored");
	expect(ignored).toBe(true);
	expect(accepted).toBe(false);
	expect(await runtime.ingestWebhook(input)).toBe("accepted");
	expect(await runtime.ingestWebhook(input)).toBe("duplicate");
	expect(h.api.dispatches).toBe(0);
	h.api.strictLeaseId = false;
	await runtime.tick();
	expect(acknowledged).toBe(true);
	expect(h.api.dispatches).toBe(1);
	const lease = h.store.all()[0];
	if (!lease) throw new Error("missing lease");
	h.api.host.display_title = `HoBo lease ${lease.id}`;
	expect((await runtime.claim(lease.id, "valid")).status).toBe(200);
});

it("never acknowledges an inbox delivery if policy verification fails", async () => {
	const h = setup();
	let acked = false;
	let released = false;
	let claimed = false;
	const payload = signed(queued());
	const store: HostedInboxStore = {
		...h.asyncStore,
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async claimWebhook() {
			if (claimed) return undefined;
			claimed = true;
			return {
				deliveryId: "delivery",
				event: "workflow_job",
				rawBody: payload.body,
				token: "owned",
			};
		},
		async ackWebhook() {
			acked = true;
			return true;
		},
		async failWebhook() {
			released = true;
			return "retry";
		},
	};
	h.api.request = async () => {
		throw new Error("provider temporarily unavailable");
	};
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
	});
	await expect(runtime.tick()).rejects.toThrow(
		/one or more inbox deliveries failed/,
	);
	expect(acked).toBe(false);
	expect(released).toBe(true);
	expect(h.store.all()).toEqual([]);
});

it("ignores unsupported GitHub workflow job actions instead of poisoning the inbox", async () => {
	const h = setup();
	const payload = { ...queued(), action: "waiting" };
	const result = await h.relay.processWebhook(
		Buffer.from(JSON.stringify(payload)),
		"workflow_job",
	);
	expect(result).toBe("ignored");
	expect(h.store.all()).toEqual([]);
});

it("drains only the requested bounded number of durable deliveries", async () => {
	const h = setup();
	const remaining = ["1", "2", "3"];
	const acknowledged: string[] = [];
	const store: HostedInboxStore = {
		...h.asyncStore,
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async claimWebhook() {
			const deliveryId = remaining.shift();
			if (!deliveryId) return undefined;
			return {
				deliveryId,
				event: "workflow_run",
				rawBody: Buffer.from(
					JSON.stringify({
						action: "completed",
						installation: { id: 10 },
						repository: { id: 101, full_name: "org/repo" },
						workflow_run: { id: 22, display_title: "unrelated" },
					}),
				),
				token: deliveryId,
			};
		},
		async ackWebhook(id, token) {
			expect(id).toBe(token);
			acknowledged.push(id);
			return true;
		},
		async failWebhook() {
			throw new Error("unexpected release");
		},
	};
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
	});
	await runtime.tick({ maxDeliveries: 2 });
	expect(acknowledged).toEqual(["1", "2"]);
	expect(remaining).toEqual(["3"]);
	await runtime.tick({ maxDeliveries: 2 });
	expect(acknowledged).toEqual(["1", "2", "3"]);
	await expect(runtime.tick({ maxDeliveries: 51 })).rejects.toThrow(
		"invalid delivery batch size",
	);
});

it("recovers stale in-flight dispatch intent as uncertain without launching twice", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.state = "dispatching";
		},
		"ci.DispatchRequested",
		NOW,
	);
	const store: HostedInboxStore = {
		...h.asyncStore,
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async claimWebhook() {
			return undefined;
		},
		async ackWebhook() {
			return true;
		},
		async failWebhook() {
			return "retry";
		},
	};
	h.api.host.display_title = "not the lease";
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => "2026-10-26T12:03:00Z",
	});
	await runtime.tick();
	expect(h.store.get(lease.id)?.state).toBe("uncertain");
	expect(h.api.dispatches).toBe(0);
});

it("never admits an acknowledged public repository to the workflow bridge", async () => {
	const h = setup();
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("fixture connection");
	connection.publicRepositoryAcknowledged = true;
	h.store.configure(h.configuration, 1, NOW);
	h.api.original.repository.private = false;
	const request = signed(queued());
	expect(
		await h.relay.webhook(request.body, request.signature, "workflow_job"),
	).toBe("ignored");
	await h.relay.dispatchPending();
	expect(h.store.all()).toEqual([]);
	expect(h.api.dispatches).toBe(0);
	expect(h.api.registrations).toBe(0);
});

it("does not dispatch a reserved host after its acknowledged repository becomes public", async () => {
	const h = setup();
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("fixture connection");
	connection.publicRepositoryAcknowledged = true;
	h.store.configure(h.configuration, 1, NOW);
	const lease = await reserve(h);
	h.api.original.repository.private = false;
	await h.relay.dispatchPending();
	expect(h.api.dispatches).toBe(0);
	expect(h.store.get(lease.id)?.state).toBe("cancelled");
});

it("refuses runner registration if its acknowledged repository becomes public after dispatch", async () => {
	const h = setup();
	const connection = h.configuration.connections[0];
	if (!connection) throw new Error("fixture connection");
	connection.publicRepositoryAcknowledged = true;
	h.store.configure(h.configuration, 1, NOW);
	const lease = await reserve(h);
	await h.relay.dispatchPending();
	h.api.original.repository.private = false;
	h.api.host.repository.private = false;
	await expect(h.relay.claim(lease.id, "valid")).rejects.toThrow(
		/authority revoked/,
	);
	expect(h.api.registrations).toBe(0);
});

it("backs off a failed delivery and still processes subsequent accounts", async () => {
	const h = setup();
	const remaining = ["poison", "valid"];
	const failed: string[] = [];
	const acknowledged: string[] = [];
	const store: HostedInboxStore = {
		...h.asyncStore,
		async acceptIgnoredWebhook() {
			return { duplicate: false };
		},
		async ready() {
			return true;
		},
		async latestLeaseIntents(ids) {
			return h.store.events().filter((event) => ids.includes(event.leaseId));
		},
		async acceptWebhook() {
			return { duplicate: false };
		},
		async claimWebhook() {
			const deliveryId = remaining.shift();
			if (!deliveryId) return undefined;
			const rawBody =
				deliveryId === "poison"
					? Buffer.from("malformed signed GitHub payload")
					: Buffer.from(
							JSON.stringify({
								action: "completed",
								installation: { id: 10 },
								repository: { id: 101, full_name: "org/repo" },
								workflow_run: { id: 22, display_title: "unrelated" },
							}),
						);
			return { deliveryId, event: "workflow_run", rawBody, token: deliveryId };
		},
		async ackWebhook(id) {
			acknowledged.push(id);
			return true;
		},
		async failWebhook(id, token, at) {
			expect(token).toBe(id);
			expect(at).toBe(NOW);
			failed.push(id);
			return "retry";
		},
	};
	const runtime = createHostedRelayRuntime({
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
	});
	await expect(runtime.tick()).rejects.toThrow(
		"one or more inbox deliveries failed",
	);
	expect(failed).toEqual(["poison"]);
	expect(acknowledged).toEqual(["valid"]);
});
