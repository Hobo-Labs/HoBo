import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type Configuration,
	ConfigurationSchema,
	ConnectionSchema,
	type Job,
	type Lease,
	LeaseSchema,
	OfferSchema,
	SandboxMeasuredUsageSchema,
	SandboxPricingSchema,
} from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { leaseIdFromBoxRunnerName } from "../src/job-runner-custody.js";
import {
	deriveSandboxProxyToken,
	isDeterministicLeaseId,
	RELAY_FEED_CAPACITY,
	type RelayDiscoveryPort,
	rebuildLease,
	relayCacheKeys,
	relayJobKey,
	relayLeaseCandidates,
	relayLeaseId,
	relayLeaseNames,
	resolveUncertainLease,
	sandboxProxyTokenDigest,
	uuidV5,
	verifySandboxProxyToken,
} from "../src/relay-cache/index.js";
import {
	configuration,
	job,
	LATER,
	NOW,
	openRelayCache,
	PROXY_KEY,
} from "./relay-cache-fixtures.js";

const HOUR = 3_600_000;
const id = (jobId: number, generation = 0) =>
	relayLeaseId({ repositoryId: 101, jobId, runAttempt: 1 }, generation);
const account = (config: Configuration = configuration()) => {
	const found = config.accounts[0];
	if (!found) throw new Error("fixture account");
	return found;
};

describe("deterministic lease ids", () => {
	it("is RFC 9562 UUIDv5", () => {
		// The RFC's DNS-namespace example.
		expect(
			uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
		).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
	});

	it("derives one id per job attempt and generation, with generation 0 the plain key", () => {
		const attempt = { repositoryId: 101, jobId: 1, runAttempt: 1 };
		expect(relayJobKey(attempt)).toBe("101:1:1");
		expect(relayLeaseId(attempt)).toBe(relayLeaseId(attempt, 0));
		expect(relayLeaseId(attempt)).toBe(relayLeaseId({ ...attempt }));
		const ids = relayLeaseCandidates(attempt, 5).map((entry) => entry.leaseId);
		expect(new Set(ids).size).toBe(6);
		expect(relayLeaseId({ ...attempt, runAttempt: 2 })).not.toBe(
			relayLeaseId(attempt),
		);
		expect(relayLeaseId(attempt, 1)).not.toBe(
			relayLeaseId({ ...attempt, runAttempt: 2 }),
		);
		for (const leaseId of ids)
			expect(isDeterministicLeaseId(leaseId)).toBe(true);
		expect(() => relayLeaseId(attempt, -1)).toThrow(/generation/);
		expect(() => relayLeaseId({ ...attempt, jobId: 0 })).toThrow(/job id/);
	});

	it("keeps the external names rediscovery looks up", () => {
		const leaseId = id(1);
		const names = relayLeaseNames(leaseId);
		expect(names).toEqual({
			runner: `hobo-${leaseId}`,
			bridgeRunTitle: `HoBo lease ${leaseId}`,
			sandbox: `hobo-${leaseId}`,
			proxySandbox: `hobo-proxy-${leaseId}`,
		});
		// The box worker's runner-name parser reads a deterministic id back.
		expect(leaseIdFromBoxRunnerName(names.runner)).toBe(leaseId);
	});
});

describe("relay cache store: concurrency", () => {
	it("gives many concurrent reservers of one job exactly one lease", async () => {
		const harness = openRelayCache();
		await harness.store.queue(job(1), NOW, 1);
		const peers = Array.from({ length: 24 }, () => harness.peer());
		const leases = await Promise.all(
			peers.map((peer) => peer.reserve(account(), job(1), NOW, 1)),
		);
		expect(new Set(leases.map((lease) => lease?.id))).toEqual(new Set([id(1)]));
		expect(
			(await harness.store.activeLeases()).map((lease) => lease.id),
		).toEqual([id(1)]);
		expect(await harness.store.pendingJobs()).toEqual([]);
		const changes = await harness.store.eventsSince({
			accountId: "hobo-labs",
			limit: 50,
		});
		expect(
			changes.events.filter(
				(entry) => entry.event?.type === "ci.LeaseReserved",
			),
		).toHaveLength(1);
	});

	it("holds the offer's concurrency across racing reservations of different jobs", async () => {
		const harness = openRelayCache();
		const peers = Array.from({ length: 8 }, () => harness.peer());
		const leases = await Promise.all(
			peers.map((peer, index) =>
				peer.reserve(account(), job(index + 1), NOW, 1),
			),
		);
		expect(leases.filter(Boolean)).toHaveLength(2);
		expect(await harness.store.activeLeases()).toHaveLength(2);
		// Losers re-read the index and re-routed; nobody wrote over a winner.
		expect(
			peers.reduce((sum, peer) => sum + peer.casRetries(), 0),
		).toBeGreaterThan(0);
	});

	it("lets exactly one of two racing transitions win and keeps the expected-state check", async () => {
		const harness = openRelayCache();
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		const [left, right] = [harness.peer(), harness.peer()];
		const move = (store: typeof left, stage: string) =>
			store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
					entry.sandboxStage = stage;
				},
				"ci.DispatchRequested",
				NOW,
			);
		const results = await Promise.all([
			move(left, "left"),
			move(right, "right"),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const winner = results.find(Boolean);
		expect((await harness.store.get(lease.id))?.sandboxStage).toBe(
			winner?.sandboxStage,
		);
	});

	it("refuses one of two racing runner assignments of a job", async () => {
		const harness = openRelayCache();
		const first = await harness.store.reserve(account(), job(1), NOW, 1);
		const second = await harness.store.reserve(account(), job(2), NOW, 1);
		if (!first || !second) throw new Error("reservation");
		const observe = (lease: Lease) => {
			const running = job(3, "in_progress");
			running.runnerName = lease.runnerName;
			return harness.peer().observe(running, NOW, 1);
		};
		const outcomes = await Promise.allSettled([
			observe(first),
			observe(second),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
		expect([first.id, second.id]).toContain(
			(await harness.store.assignedJob(job(3)))?.leaseId,
		);
	});
});

describe("relay cache store: TTLs", () => {
	it("keeps a lease past GitHub's queue limit and lets it lapse after", async () => {
		const harness = openRelayCache();
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		harness.clock.advance(24 * HOUR);
		expect(await harness.store.get(lease.id)).toBeDefined();
		harness.clock.advance(2 * HOUR);
		expect(await harness.store.get(lease.id)).toBeUndefined();
	});

	it("keeps a terminal job marker for the dedupe window only", async () => {
		const harness = openRelayCache();
		await harness.store.observe(job(1, "completed"), NOW, 1);
		await harness.store.queue(job(1), NOW, 1);
		expect(await harness.store.pendingJobs()).toEqual([]);
		harness.clock.advance(24 * HOUR + 1);
		// After the window the relay re-reads GitHub before queueing (the
		// queued-job scan does); the cache alone no longer remembers.
		await harness.store.queue(
			job(1),
			new Date(Date.parse(NOW) + 25 * HOUR).toISOString(),
			1,
		);
		expect(
			(await harness.store.pendingJobs()).map((entry) => entry.id),
		).toEqual([1]);
	});

	it("forgets webhook delivery ids after 24 hours", async () => {
		const harness = openRelayCache();
		const body = Buffer.from('{"action":"queued"}');
		const input = {
			deliveryId: "d-1",
			event: "workflow_job",
			installationId: 10,
			repositoryId: 101,
			rawBody: body,
			receivedAt: NOW,
		};
		await harness.store.acceptWebhook(input);
		harness.clock.advance(24 * HOUR + 1);
		expect(await harness.store.hasWebhook("d-1")).toBe(false);
	});

	it("resets a cursor the change ring no longer covers", async () => {
		const harness = openRelayCache();
		await harness.store.queue(job(1), NOW, 1);
		const page = await harness.store.eventsSince({
			accountId: "hobo-labs",
			limit: 10,
		});
		harness.clock.advance(HOUR + 1);
		await harness.store.queue(job(2), LATER, 1);
		const after = await harness.store.eventsSince({
			accountId: "hobo-labs",
			after: page.cursor + 5,
			limit: 10,
		});
		expect(after.truncated).toBe(true);
		expect(after.events.map((entry) => entry.event?.type)).toEqual([
			"ci.JobQueued",
		]);
	});

	it("caps the change ring per account", async () => {
		const harness = openRelayCache();
		for (let n = 1; n <= RELAY_FEED_CAPACITY + 3; n++)
			await harness.store.queue(job(n), NOW);
		const stale = await harness.store.eventsSince({
			accountId: "hobo-labs",
			after: 1,
			limit: 5,
		});
		expect(stale.truncated).toBe(true);
		const fresh = await harness.store.eventsSince({
			accountId: "hobo-labs",
			after: RELAY_FEED_CAPACITY,
			limit: 5,
		});
		expect(fresh.truncated).toBe(false);
		expect(fresh.events).toHaveLength(3);
	});
});

function fakeDiscovery(world: {
	github?: { status: string; runnerName?: string; createdAt?: string };
	runners?: string[];
	bridgeRuns?: Record<string, number>;
	sandboxes?: Record<string, string>;
}): RelayDiscoveryPort & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		job: async () => {
			calls.push("job");
			return world.github;
		},
		runner: async (_job, name) => {
			calls.push(`runner:${name}`);
			return world.runners?.includes(name) ? { id: 7 } : undefined;
		},
		bridgeRun: async (_job, title) => {
			calls.push(`bridge:${title}`);
			const run = world.bridgeRuns?.[title];
			return run ? { id: run } : undefined;
		},
		sandbox: async (name) => {
			calls.push(`sandbox:${name}`);
			const session = world.sandboxes?.[name];
			return session ? { sessionId: session } : undefined;
		},
	};
}

describe("relay cache store: cache loss and rebuild by name", () => {
	it("rebuilds an assigned lease from GitHub's runner name after the cache is emptied", async () => {
		const harness = openRelayCache();
		await harness.store.queue(job(1), NOW, 1);
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		harness.flush();
		expect(await harness.store.get(lease.id)).toBeUndefined();
		const discovery = fakeDiscovery({
			github: {
				status: "in_progress",
				runnerName: lease.runnerName,
				createdAt: NOW,
			},
		});
		const outcome = await rebuildLease(harness.store, discovery, job(1), LATER);
		expect(outcome).toEqual({
			kind: "rebuilt",
			leaseId: lease.id,
			from: "runner",
		});
		expect(await harness.store.get(lease.id)).toMatchObject({
			state: "uncertain",
			actualJobId: 1,
			runnerName: `hobo-${lease.id}`,
			offerId: "box-isolated",
			queueDeadlineAt: "",
		});
		expect(
			(await harness.store.activeLeases()).map((entry) => entry.id),
		).toEqual([lease.id]);
		expect((await harness.store.assignedJob(job(1)))?.leaseId).toBe(lease.id);
		// The rebuilt lease holds its slot, so it is not admitted twice.
		expect(
			await harness.store.reserve(account(), job(1), LATER, 1),
		).toBeUndefined();
		expect(await rebuildLease(harness.store, discovery, job(1), LATER)).toEqual(
			{
				kind: "present",
				leaseId: lease.id,
			},
		);
	});

	it("rebuilds from a bridge run or sandbox with no runner, and prefers the newest generation", async () => {
		const harness = openRelayCache();
		const discovery = fakeDiscovery({
			github: { status: "queued", createdAt: NOW },
			bridgeRuns: { [`HoBo lease ${id(1, 0)}`]: 41 },
			sandboxes: { [`hobo-${id(1, 2)}`]: "sbx_two" },
		});
		const outcome = await rebuildLease(harness.store, discovery, job(1), LATER);
		expect(outcome).toEqual({
			kind: "rebuilt",
			leaseId: id(1, 2),
			from: "sandbox",
		});
		expect(await harness.store.get(id(1, 2))).toMatchObject({
			state: "uncertain",
			sandboxName: `hobo-${id(1, 2)}`,
			sandboxSessionId: "sbx_two",
			budgetAdmissionAttempt: 3,
		});
	});

	it("re-queues a job with nothing under any of its names, and tombstones a completed one", async () => {
		const harness = openRelayCache();
		const queued = fakeDiscovery({
			github: { status: "queued", createdAt: NOW },
		});
		expect(await rebuildLease(harness.store, queued, job(1), LATER)).toEqual({
			kind: "pending",
		});
		expect(
			(await harness.store.pendingJobs()).map((entry) => entry.id),
		).toEqual([1]);
		// Each candidate generation was looked up by every name it implies.
		expect(
			queued.calls.filter((call) => call.startsWith("sandbox:")),
		).toHaveLength(4);
		const done = fakeDiscovery({ github: { status: "completed" } });
		expect(await rebuildLease(harness.store, done, job(2), LATER)).toEqual({
			kind: "terminal",
		});
		await harness.store.queue(job(2), LATER, 1);
		expect(
			(await harness.store.pendingJobs()).map((entry) => entry.id),
		).toEqual([1]);
		const foreign = fakeDiscovery({
			github: { status: "in_progress", runnerName: "arc-runner-1" },
		});
		expect(await rebuildLease(harness.store, foreign, job(3), LATER)).toEqual({
			kind: "foreign",
		});
	});

	it("re-adopts a surviving lease when only the job record and index were lost", async () => {
		const harness = openRelayCache();
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		const keys = relayCacheKeys("test");
		await harness.state.delete(keys.job("101:1:1"));
		await harness.state.delete(keys.inflight("hobo-labs"));
		expect(await harness.store.activeLeases()).toEqual([]);
		const discovery = fakeDiscovery({});
		expect(await rebuildLease(harness.store, discovery, job(1), LATER)).toEqual(
			{
				kind: "adopted",
				leaseId: lease.id,
			},
		);
		expect(discovery.calls).toEqual([]);
		expect(
			(await harness.store.activeLeases()).map((entry) => entry.id),
		).toEqual([lease.id]);
		expect((await harness.store.reserve(account(), job(1), LATER, 1))?.id).toBe(
			lease.id,
		);
	});

	it("moves past a spent lease id when the job record was lost", async () => {
		const harness = openRelayCache();
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		await harness.store.cancelAndRequeue(lease.id, job(1), NOW);
		await harness.state.delete(relayCacheKeys("test").job("101:1:1"));
		const next = await harness.store.reserve(account(), job(1), LATER, 1);
		expect(next?.id).toBe(id(1, 1));
		expect(
			(await harness.store.activeLeases()).map((entry) => entry.id),
		).toEqual([id(1, 1)]);
	});

	it("resolves an uncertain lease with nothing behind it by re-admitting the next generation", async () => {
		const harness = openRelayCache();
		await harness.store.queue(job(1), NOW, 1);
		const lease = await harness.store.reserve(account(), job(1), NOW, 1);
		if (!lease) throw new Error("reservation");
		await harness.store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "uncertain";
			},
			"ci.LeaseUncertain",
			NOW,
		);
		const evidence = fakeDiscovery({
			github: { status: "queued" },
			runners: [lease.runnerName],
		});
		const found = await resolveUncertainLease(
			harness.store,
			evidence,
			lease.id,
			LATER,
		);
		expect(found.kind).toBe("evidence");
		expect((await harness.store.get(lease.id))?.state).toBe("uncertain");
		const nothing = fakeDiscovery({ github: { status: "queued" } });
		expect(
			await resolveUncertainLease(harness.store, nothing, lease.id, LATER),
		).toEqual({
			kind: "requeued",
			nextGeneration: 1,
		});
		expect((await harness.store.get(lease.id))?.state).toBe("cancelled");
		expect((await harness.store.reserve(account(), job(1), LATER, 1))?.id).toBe(
			id(1, 1),
		);
	});
});

function pricedConfiguration(): Configuration {
	return create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "hobo-labs",
				budgetMicros: 100_000,
				maxRuntimeMinutes: 30,
				startupMinutes: 5,
				offers: [
					create(OfferSchema, {
						id: "gh-paid",
						provider: "github",
						providerAccountId: "org",
						enabled: true,
						backend: "gh-actions",
						freeMinutes: 0,
						priceMicrosPerMinute: 1000,
						budgetMicros: 1_000_000,
						concurrency: 10,
						observedAt: "2026-11-02T00:00:00Z",
						validUntil: "2026-12-31T23:59:59Z",
						sourceUrl: "https://example.test/price",
						bridgeAcknowledged: true,
					}),
				],
			}),
		],
		connections: [
			create(ConnectionSchema, {
				accountId: "hobo-labs",
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				acceptAllMatchingRepositoryJobs: true,
				trustedRepositoryAcknowledged: true,
			}),
		],
	});
}
const sharedJob = (n: number): Job => {
	const entry = job(n);
	entry.isolatedRequired = false;
	return entry;
};

describe("relay cache store: budgets without history", () => {
	it("pauses priced offers until a rebuild pass restores the holds", async () => {
		const config = pricedConfiguration();
		const harness = openRelayCache(config);
		expect(
			await harness.store.reserve(account(config), sharedJob(1), NOW, 1),
		).toBeUndefined();
		await harness.store.markHoldsKnown("hobo-labs", NOW);
		expect(
			await harness.store.reserve(account(config), sharedJob(1), NOW, 1),
		).toMatchObject({
			offerId: "gh-paid",
			reservedPaidMicros: 35_000,
		});
		harness.flush();
		expect(
			await harness.store.reserve(account(config), sharedJob(2), NOW, 1),
		).toBeUndefined();
	});

	it("counts in-flight holds plus pulled usage, and nothing for finished leases", async () => {
		const config = pricedConfiguration();
		let spent: number | undefined;
		const harness = openRelayCache(config, {
			usage: {
				observed: async () =>
					spent === undefined
						? undefined
						: { observedAt: NOW, accountSpentMicros: spent },
			},
		});
		await harness.store.markHoldsKnown("hobo-labs", NOW);
		const first = await harness.store.reserve(
			account(config),
			sharedJob(1),
			NOW,
			1,
		);
		const second = await harness.store.reserve(
			account(config),
			sharedJob(2),
			NOW,
			1,
		);
		expect(first && second).toBeTruthy();
		// 2 × 35,000 held; a third 35,000 would cross the 100,000 cap.
		expect(
			await harness.store.reserve(account(config), sharedJob(3), NOW, 1),
		).toBeUndefined();
		if (!first) throw new Error("reservation");
		await harness.store.settle(first.id, 0, 30, LATER);
		// The settled lease's spend is the provider's to report; its hold is released.
		expect(
			await harness.store.reserve(account(config), sharedJob(3), LATER, 1),
		).toBeDefined();
		await harness.store.settle(second?.id ?? "", 0, 30, LATER);
		spent = 80_000;
		expect(
			await harness.store.reserve(account(config), sharedJob(4), LATER, 1),
		).toBeUndefined();
	});

	it("refuses Broker budget-policy accounts, as the hosted relay always has", async () => {
		const config = pricedConfiguration();
		const policyAccount = create(AccountSchema, {
			...account(config),
			budgetPolicy: {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "tenant",
				budgetId: "shared",
				periodId: "p1",
				revision: "r1",
				workloads: ["ci"],
				currency: "USD",
				limitMicros: 100_000,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
			},
		});
		config.accounts = [policyAccount];
		const harness = openRelayCache(config);
		await harness.store.markHoldsKnown("hobo-labs", NOW);
		expect(
			await harness.store.reserve(policyAccount, sharedJob(1), NOW, 1),
		).toBeUndefined();
		expect(await harness.store.activeLeases()).toEqual([]);
	});
});

function sandboxLease(): Lease {
	const leaseId = id(7);
	return create(LeaseSchema, {
		id: leaseId,
		accountId: "hobo-labs",
		offerId: "vercel-sandbox",
		provider: "vercel",
		providerAccountId: "team",
		jobId: 7,
		originalRunId: 900,
		runAttempt: 1,
		repositoryId: 101,
		repository: "Org/Repo",
		installationId: 10,
		state: "uncertain",
		reservedMinutes: 35,
		runnerName: `hobo-${leaseId}`,
		sandboxName: `hobo-${leaseId}`,
		sandboxSessionId: "sbx_guest",
		sandboxStage: "running",
		proxySandboxName: `hobo-proxy-${leaseId}`,
		proxySandboxSessionId: "sbx_proxy",
		proxySandboxStage: "running",
		sandboxPricing: create(SandboxPricingSchema, {
			proxyVmRequired: true,
			proxyControlMaxCalls: 3,
			maxEgressBytes: 1000,
			proxyVmExtraMs: 60_000,
		}),
		createdAt: NOW,
	});
}

describe("relay cache store: sandbox egress and proxy caps", () => {
	async function sandbox() {
		const harness = openRelayCache();
		const lease = sandboxLease();
		await harness.store.rebuildAccess().createLease(lease, 0, "sandbox");
		const token = harness.store.sandboxProxyToken(lease.id);
		const digest = sandboxProxyTokenDigest(token);
		return { harness, lease, token, digest };
	}

	it("derives the proxy token from the lease id and refuses any other", async () => {
		const { harness, lease, token, digest } = await sandbox();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(verifySandboxProxyToken(PROXY_KEY, token)).toBe(lease.id);
		expect(deriveSandboxProxyToken(PROXY_KEY, lease.id)).toBe(token);
		await expect(
			harness.store.configureSandboxProxy(
				"hobo-labs",
				lease.id,
				"sbx_proxy",
				"a".repeat(64),
				1,
			),
		).rejects.toThrow(/derived token/);
		await harness.store.configureSandboxProxy(
			"hobo-labs",
			lease.id,
			"sbx_proxy",
			digest,
			1,
		);
		const forged = `${token.slice(0, 30)}${token[30] === "A" ? "B" : "A"}${token.slice(31)}`;
		expect(
			await harness.store.authenticateSandboxProxy(forged),
		).toBeUndefined();
		expect(
			await harness.store.authenticateSandboxProxy(digest),
		).toBeUndefined();
		expect(await harness.store.authenticateSandboxProxy(token)).toEqual({
			accountId: "hobo-labs",
			leaseId: lease.id,
			proxySessionId: "sbx_proxy",
		});
	});

	it("counts every authenticated attempt against the control-call cap", async () => {
		const { harness, lease, token, digest } = await sandbox();
		await harness.store.configureSandboxProxy(
			"hobo-labs",
			lease.id,
			"sbx_proxy",
			digest,
			1,
		);
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				harness.store.authenticateSandboxProxy(token),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(3);
	});

	it("caps forwarded bytes atomically and refuses a replayed request", async () => {
		const { harness, lease, digest } = await sandbox();
		await harness.store.configureSandboxProxy(
			"hobo-labs",
			lease.id,
			"sbx_proxy",
			digest,
			1,
		);
		await harness.store.configureSandboxEgress(
			"hobo-labs",
			lease.id,
			"sbx_guest",
			1000,
			1,
		);
		await expect(
			harness.store.configureSandboxEgress(
				"hobo-labs",
				id(8),
				"sbx_guest",
				1000,
				1,
			),
		).rejects.toThrow(/binding invalid|already bound/);
		const request = (n: number, bytes: number) =>
			harness.store.reserveSandboxProxyEgress(
				lease.id,
				"sbx_proxy",
				digest,
				"sbx_guest",
				bytes,
				`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
			);
		expect(await request(1, 600)).toBe(true);
		expect(await request(1, 10)).toBe(false);
		// Two racing 300-byte requests: at most one fits under the remaining 400.
		const raced = await Promise.all([request(2, 300), request(3, 300)]);
		expect(raced.filter(Boolean)).toHaveLength(1);
		expect(
			await harness.store.sandboxEgressUsage(
				"hobo-labs",
				lease.id,
				"sbx_guest",
			),
		).toBe(900);
		expect(await request(4, 200)).toBe(false);
		expect(
			await harness.store.sandboxEgressUsage("other", lease.id, "sbx_guest"),
		).toBeUndefined();
	});

	it("reports the meters to settlement once the proxy has stopped, and lets them lapse after the sandbox", async () => {
		const { harness, lease, token, digest } = await sandbox();
		await harness.store.configureSandboxProxy(
			"hobo-labs",
			lease.id,
			"sbx_proxy",
			digest,
			1,
		);
		await harness.store.configureSandboxEgress(
			"hobo-labs",
			lease.id,
			"sbx_guest",
			1000,
			1,
		);
		await harness.store.authenticateSandboxProxy(token);
		await harness.store.reserveSandboxProxyEgress(
			lease.id,
			"sbx_proxy",
			digest,
			"sbx_guest",
			250,
			"00000000-0000-4000-8000-000000000001",
		);
		expect(
			await harness.store.sandboxProxyUsage(
				"hobo-labs",
				lease.id,
				"sbx_proxy",
				"sbx_guest",
			),
		).toBeUndefined();
		await harness.store.transition(
			lease.id,
			["uncertain"],
			(entry) => {
				entry.proxySandboxStage = "stopped";
				entry.proxyStoppedUsage = create(SandboxMeasuredUsageSchema, {
					sessionId: "sbx_proxy",
					stoppedAt: LATER,
				});
			},
			"ci.ProxyStopped",
			LATER,
		);
		expect(
			await harness.store.sandboxProxyUsage(
				"hobo-labs",
				lease.id,
				"sbx_proxy",
				"sbx_guest",
			),
		).toEqual({ bytes: 250, calls: 1 });
		// Counters live for the sandbox's lifetime (35 min + proxy time) plus an hour.
		harness.clock.advance(35 * 60_000 + 60_000 + HOUR + 1);
		expect(
			await harness.store.sandboxEgressUsage(
				"hobo-labs",
				lease.id,
				"sbx_guest",
			),
		).toBeUndefined();
	});
});

describe("relay cache store: command cost", () => {
	it("meters a workflow-bridge-style job path end to end", async () => {
		const harness = openRelayCache();
		const cost: Record<string, number> = {};
		const step = async <Result>(name: string, run: () => Promise<Result>) => {
			const before = harness.meter.usage().total;
			await run();
			cost[name] = harness.meter.usage().total - before;
		};
		await harness.store.reserve(account(), job(99), NOW, 1); // warm script cache
		const body = (action: string) =>
			Buffer.from(JSON.stringify({ action, workflow_job: { id: 1 } }));
		const deliver = (n: number, action: string) =>
			harness.store.acceptWebhook({
				deliveryId: `d-${n}`,
				event: "workflow_job",
				installationId: 10,
				repositoryId: 101,
				rawBody: body(action),
				receivedAt: NOW,
			});
		await step("intake (dedupe)", () => deliver(1, "queued"));
		await step("queue", () => harness.store.queue(job(1), NOW, 1));
		let lease: Lease | undefined;
		await step("reserve", async () => {
			lease = await harness.store.reserve(account(), job(1), NOW, 1);
		});
		if (!lease) throw new Error("reservation");
		const leaseId = lease.id;
		const move = (to: string, type: string, from: string) =>
			harness.store.transition(
				leaseId,
				[from],
				(entry) => {
					entry.state = to;
				},
				type,
				NOW,
			);
		await step("dispatch intent", () =>
			move("dispatching", "ci.DispatchRequested", "reserved"),
		);
		await step("dispatch outcome", () =>
			move("dispatched", "ci.Dispatched", "dispatching"),
		);
		await step("claim", () =>
			move("claiming", "ci.RunnerClaimed", "dispatched"),
		);
		await step("intent check (tick)", () =>
			harness.store.latestLeaseIntents([leaseId]),
		);
		const running = job(1, "in_progress");
		running.runnerName = lease.runnerName;
		await step("in progress", () => harness.store.observe(running, NOW, 1));
		await step("running", () =>
			move("running", "ci.RunnerStarted", "claiming"),
		);
		const completed = job(1, "completed");
		completed.runnerName = lease.runnerName;
		await step("completed", () => harness.store.observe(completed, LATER, 1));
		await step("settle", () => harness.store.settle(leaseId, 0, 3, LATER));
		const total = Object.values(cost).reduce((sum, value) => sum + value, 0);
		// Pinned so a change in cost is a reviewed change. Each change-ring
		// append is 2 commands until the account's ring first fills, 3 after
		// (11 appends on this path); the rest is records, index and pending set.
		expect(cost).toEqual({
			"intake (dedupe)": 3,
			queue: 6,
			reserve: 11,
			"dispatch intent": 5,
			"dispatch outcome": 4,
			claim: 5,
			"intent check (tick)": 1,
			"in progress": 8,
			running: 5,
			completed: 8,
			settle: 6,
		});
		expect(total).toBe(62);
	});

	it("meters one proxied sandbox request", async () => {
		const harness = openRelayCache();
		const lease = sandboxLease();
		await harness.store.rebuildAccess().createLease(lease, 0, "sandbox");
		const token = harness.store.sandboxProxyToken(lease.id);
		const digest = sandboxProxyTokenDigest(token);
		await harness.store.configureSandboxProxy(
			"hobo-labs",
			lease.id,
			"sbx_proxy",
			digest,
			1,
		);
		await harness.store.configureSandboxEgress(
			"hobo-labs",
			lease.id,
			"sbx_guest",
			1000,
			1,
		);
		const before = harness.meter.usage().total;
		await harness.store.authenticateSandboxProxy(token);
		const authenticated = harness.meter.usage().total;
		await harness.store.reserveSandboxProxyEgress(
			lease.id,
			"sbx_proxy",
			digest,
			"sbx_guest",
			10,
			"00000000-0000-4000-8000-000000000001",
		);
		// Authenticate: lease read + call counter. Reserve: lease and binding
		// reads, request dedupe, rate window, request total, byte counter.
		expect(authenticated - before).toBe(2);
		expect(harness.meter.usage().total - authenticated).toBe(6);
	});
});
