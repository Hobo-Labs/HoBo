/**
 * The CI store contract (`ci-store-contract.test.ts`) ported to the relay's
 * cache store on the in-memory ephemeral-state engine.
 *
 * Scenarios about durable history are deliberately not ported (ADR-0179 and
 * docs/design/hosted-relay-stateless.md, "Former tables"):
 * - configuration compare-and-swap through the store: config is read-only on
 *   the hosted relay, written by `hobo ci` to the config service; the store
 *   refuses writes (covered below as a refusal instead);
 * - control-record round trip and monotonic terminal status: the
 *   `hobo_ci_control_records` table is gone; operations live in `hobo ci`;
 * - webhook claim/ack/back-off/quarantine: the inbox is replaced by Vercel
 *   Queue intake (phase 4b); a delivery that cannot be admitted is logged and
 *   dropped, not quarantined. Dedupe and replay-guard are kept;
 * - every journal-index scenario (SQLite lease and account indexes, Postgres
 *   partition lock, account stamping, digit-growth ordering): there is no
 *   journal; the per-account change ring replaces it for live changes only.
 */
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ConnectionSchema, eventJob } from "@hobo/ci";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedControlStore } from "../src/hosted-control.js";
import type { HostedInboxStore } from "../src/hosted-runtime.js";
import {
	createIsolatedContainerController,
	type IsolatedWorkerStore,
} from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import {
	RelayCacheStore,
	RelayConfigReadOnlyError,
	relayLeaseId,
} from "../src/relay-cache/index.js";
import type { RelayMcpStore } from "../src/relay-mcp-server.js";
import {
	configuration,
	delivery,
	foreignJob,
	job,
	LATER,
	NOW,
	openRelayCache,
	type RelayCacheHarness,
	twoAccounts,
} from "./relay-cache-fixtures.js";

/**
 * Compile-time conformance: the cache store is every store port the hosted
 * relay composes today (ci-vercel's SandboxLeaseStore and ProxyQuotaStore are
 * the same method shapes; that package cannot be imported from here).
 */
type HostedRelayPorts = HostedInboxStore &
	HostedControlStore &
	IsolatedWorkerStore &
	RelayMcpStore;
const conforms = (store: RelayCacheStore): HostedRelayPorts => store;

describe("relay cache store: CI store contract", () => {
	let harness: RelayCacheHarness;
	it("implements the hosted relay's store ports", () => {
		expect(conforms(openRelayCache().store)).toBeInstanceOf(RelayCacheStore);
	});
	let revision = 1;
	const account = () => {
		const found = configuration().accounts[0];
		if (!found) throw new Error("fixture account");
		return found;
	};
	beforeEach(() => {
		harness = openRelayCache();
		revision = harness.config.revision();
	});

	it("serves read-only configuration and refuses configuration writes", async () => {
		const { store } = harness;
		expect((await store.configuration())?.revision).toBe(1);
		expect(await store.ready()).toBe(true);
		const snapshot = await store.policySnapshot();
		expect(snapshot.state?.revision).toBe(1);
		expect(snapshot.policies).toEqual([]);
		await expect(store.configure()).rejects.toBeInstanceOf(
			RelayConfigReadOnlyError,
		);
		await expect(store.putControlRecordMonotonic()).rejects.toThrow(
			/read-only/,
		);
		await expect(store.queue(job(2), NOW, revision + 1)).rejects.toThrow(
			/configuration revision conflict/,
		);
	});

	it("serves a policy record from configuration", async () => {
		harness.config.set(configuration(), [
			{ accountId: "hobo-labs", bodyJson: '{"maxRuntimeMinutes":30}' },
		]);
		expect(
			(await harness.store.controlRecord("ci-policy:hobo-labs"))?.bodyJson,
		).toBe('{"maxRuntimeMinutes":30}');
		expect(await harness.store.controlRecord("contract:note")).toBeUndefined();
	});

	it("fences and retires an interrupted isolated create", async () => {
		const { store } = harness;
		const demand = job(1);
		await store.queue(demand, NOW, revision);
		const lease = await store.reserve(account(), demand, NOW, revision);
		if (!lease) throw new Error("missing isolated lease");
		await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
				entry.sandboxName = `hobo-${entry.id}`;
				entry.sandboxStage = "creating";
			},
			"ci.DispatchRequested",
			NOW,
		);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
			list: vi.fn(async () => [
				{
					name: `hobo-${lease.id}`,
					containerId: "session",
					state: "running" as const,
				},
			]),
		};
		const controller = createIsolatedContainerController({
			store,
			docker,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			publicOrigin: "https://relay.example",
			now: () => LATER,
			github: {
				request: async () =>
					Response.json({
						id: 1,
						run_id: 900,
						status: "completed",
						labels: ["hobo"],
					}),
			},
		});
		await controller.reconcileLeases();
		expect(docker.stop).toHaveBeenCalledWith(`hobo-${lease.id}`, "session");
		expect(docker.remove).toHaveBeenCalledOnce();
		expect(await store.get(lease.id)).toMatchObject({
			state: "completed",
			sandboxStage: "stopped",
			usageCompletedAt: LATER,
		});
		expect(
			await store.transition(
				lease.id,
				["dispatching"],
				(entry) => {
					entry.state = "dispatched";
				},
				"ci.SandboxCreated",
				LATER,
			),
		).toBeUndefined();
	});

	it("dedupes queued demand", async () => {
		const { store } = harness;
		await store.queue(job(1), NOW, revision);
		await store.queue(job(1), NOW, revision);
		expect((await store.pendingJobs()).map((entry) => entry.id)).toEqual([1]);
	});

	it("reserves isolated demand on the zero-price box offer", async () => {
		const { store } = harness;
		await store.queue(job(1), NOW, revision);
		const lease = await store.reserve(account(), job(1), NOW, revision);
		expect(lease).toMatchObject({
			id: relayLeaseId({ repositoryId: 101, jobId: 1, runAttempt: 1 }),
			provider: "kubernetes",
			offerId: "box-isolated",
			state: "reserved",
			jobId: 1,
			reservedPaidMicros: 0,
			runnerName: `hobo-${lease?.id}`,
		});
		expect(await store.pendingJobs()).toEqual([]);
		expect((await store.reserve(account(), job(1), NOW, revision))?.id).toBe(
			lease?.id,
		);
		expect((await store.activeLeases()).map((entry) => entry.id)).toEqual([
			lease?.id,
		]);
		expect((await store.accountLeases("hobo-labs")).length).toBe(1);
		expect((await store.get(lease?.id ?? ""))?.state).toBe("reserved");
		// Offer concurrency is two: a third job waits for capacity.
		await store.reserve(account(), job(2), NOW, revision);
		expect(await store.reserve(account(), job(3), NOW, revision)).toBe(
			undefined,
		);
	});

	it("fails closed for unbound repositories", async () => {
		const foreign = job(1);
		foreign.repositoryId = 999;
		await expect(
			harness.store.reserve(account(), foreign, NOW),
		).rejects.toThrow(/connection revoked/);
	});

	it("fences transitions by state and exposes the latest intent", async () => {
		const { store } = harness;
		const lease = await store.reserve(account(), job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		const moved = await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.sandboxName = `hobo-${lease.id}`;
				entry.state = "dispatching";
			},
			"ci.DispatchRequested",
			NOW,
			revision,
		);
		expect(moved?.state).toBe("dispatching");
		expect(
			await store.transition(
				lease.id,
				["reserved"],
				() => undefined,
				"ci.DispatchRequested",
				NOW,
			),
		).toBe(undefined);
		const intents = await store.latestLeaseIntents([lease.id, randomUUID()]);
		expect(
			intents.map((event) => [event.leaseId, event.type, event.at]),
		).toEqual([[lease.id, "ci.DispatchRequested", NOW]]);
		expect(await store.latestLeaseIntents([])).toEqual([]);
	});

	it("reads an account's changes after a cursor, in ring order", async () => {
		const { store } = harness;
		await store.queue(job(1), NOW, revision);
		const lease = await store.reserve(account(), job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		const newest = await store.eventsSince({
			accountId: "hobo-labs",
			limit: 10,
		});
		expect(newest.events.map((entry) => entry.event?.type)).toEqual([
			"ci.JobQueued",
			"ci.LeaseReserved",
		]);
		const positions = newest.events.map((entry) => entry.seq);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(newest.cursor).toBe(positions.at(-1));
		const idle = await store.eventsSince({
			accountId: "hobo-labs",
			after: newest.cursor,
			limit: 10,
		});
		expect(idle.events).toEqual([]);
		expect(idle.cursor).toBe(newest.cursor);
		await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
			},
			"ci.DispatchRequested",
			LATER,
			revision,
		);
		const next = await store.eventsSince({
			accountId: "hobo-labs",
			after: newest.cursor,
			limit: 10,
		});
		expect(
			next.events.map((entry) => [entry.event?.type, entry.event?.leaseId]),
		).toEqual([["ci.DispatchRequested", lease.id]]);
		const walked: string[] = [];
		let after = 0;
		for (;;) {
			const page = await store.eventsSince({
				accountId: "hobo-labs",
				after,
				limit: 1,
			});
			if (page.events.length === 0) break;
			walked.push(page.events[0]?.event?.type ?? "");
			after = page.cursor;
		}
		expect(walked).toEqual([
			"ci.JobQueued",
			"ci.LeaseReserved",
			"ci.DispatchRequested",
		]);
		expect(
			(
				await store.eventsSince({ accountId: "hobo-labs", limit: 2 })
			).events.map((entry) => entry.event?.type),
		).toEqual(["ci.LeaseReserved", "ci.DispatchRequested"]);
		await expect(
			store.eventsSince({ accountId: "", limit: 10 }),
		).rejects.toThrow(/account/);
		await expect(
			store.eventsSince({ accountId: "hobo-labs", limit: 0 }),
		).rejects.toThrow(/limit/);
	});

	it("reads a lease's changes by its id, for its own account only", async () => {
		const { store } = harness;
		const first = await store.reserve(account(), job(1), NOW, revision);
		const second = await store.reserve(account(), job(2), NOW, revision);
		if (!first || !second) throw new Error("reservation");
		await store.transition(
			first.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
			},
			"ci.DispatchRequested",
			LATER,
			revision,
		);
		const events = await store.leaseEvents({
			accountId: "hobo-labs",
			leaseId: first.id,
			limit: 20,
		});
		expect(events.map((entry) => entry.event?.type)).toEqual([
			"ci.LeaseReserved",
			"ci.DispatchRequested",
		]);
		expect(
			(
				await store.leaseEvents({
					accountId: "hobo-labs",
					leaseId: first.id,
					limit: 1,
				})
			).map((entry) => entry.event?.type),
		).toEqual(["ci.DispatchRequested"]);
		expect(
			await store.leaseEvents({
				accountId: "other-co",
				leaseId: first.id,
				limit: 20,
			}),
		).toEqual([]);
		await expect(
			store.leaseEvents({ accountId: "hobo-labs", leaseId: "", limit: 20 }),
		).rejects.toThrow(/lease/);
	});

	it("keeps a job change with the account that owned the repository when it was written", async () => {
		const { store } = harness;
		await store.queue(job(1), NOW, revision);
		const moved = twoAccounts();
		const [, theirs] = moved.connections;
		if (!theirs) throw new Error("fixture connection");
		moved.connections = [
			create(ConnectionSchema, {
				...theirs,
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
			}),
		];
		revision = harness.config.set(moved);
		await store.observe(job(1, "completed"), LATER, revision);
		await store.queue(job(2), LATER, revision);
		const jobs = async (accountId: string) =>
			(await store.eventsSince({ accountId, after: 0, limit: 50 })).events.map(
				(entry) => [
					entry.event?.type,
					entry.event ? eventJob(entry.event)?.id : undefined,
				],
			);
		expect(await jobs("hobo-labs")).toEqual([["ci.JobQueued", 1]]);
		expect(await jobs("other-co")).toEqual([
			["ci.JobCompleted", 1],
			["ci.JobQueued", 2],
		]);
	});

	it("never reads another account's changes", async () => {
		harness = openRelayCache(twoAccounts());
		const { store } = harness;
		const [mine, theirs] = twoAccounts().accounts;
		if (!mine || !theirs) throw new Error("fixture accounts");
		await store.queue(job(1), NOW, revision);
		await store.queue(foreignJob(2), NOW, revision);
		const lease = await store.reserve(mine, job(1), NOW, revision);
		const foreign = await store.reserve(theirs, foreignJob(2), NOW, revision);
		if (!lease || !foreign) throw new Error("reservation");
		for (const [accountId, leaseId, jobId] of [
			["hobo-labs", lease.id, 1],
			["other-co", foreign.id, 2],
		] as const) {
			const page = await store.eventsSince({ accountId, after: 0, limit: 50 });
			expect(
				page.events.map((entry) => [
					entry.event?.type,
					entry.event?.leaseId ?? "",
				]),
			).toEqual([
				["ci.JobQueued", ""],
				["ci.LeaseReserved", leaseId],
			]);
			expect(page.events[0]?.event?.detail).toContain(`"id":${jobId}`);
			expect(
				(await store.eventsSince({ accountId, limit: 50 })).events,
			).toEqual(page.events);
		}
		expect(
			(await store.eventsSince({ accountId: "nobody", after: 0, limit: 50 }))
				.events,
		).toEqual([]);
	});

	it("pages an account's changes exactly, whatever another account does", async () => {
		harness = openRelayCache(twoAccounts());
		const { store } = harness;
		const [mine, theirs] = twoAccounts().accounts;
		if (!mine || !theirs) throw new Error("fixture accounts");
		await store.queue(job(1), NOW, revision);
		for (let index = 0; index < 25; index += 1)
			await store.queue(foreignJob(100 + index), NOW);
		await store.queue(job(2), NOW, revision);
		const all = await store.eventsSince({
			accountId: "hobo-labs",
			after: 0,
			limit: 10,
		});
		expect(all.events.map((entry) => entry.event?.accountId)).toEqual([
			"hobo-labs",
			"hobo-labs",
		]);
		expect(all.more).toBe(false);
		expect(all.truncated).toBe(false);
		const [first, second] = all.events.map((entry) => entry.seq);
		expect(all.cursor).toBe(second);
		const page = await store.eventsSince({
			accountId: "hobo-labs",
			after: 0,
			limit: 1,
		});
		expect(page.events.map((entry) => entry.seq)).toEqual([first]);
		expect(page.more).toBe(true);
		const rest = await store.eventsSince({
			accountId: "hobo-labs",
			after: page.cursor,
			limit: 1,
		});
		expect(rest.events.map((entry) => entry.seq)).toEqual([second]);
		expect(rest.more).toBe(false);
		const one = await store.eventsSince({ accountId: "hobo-labs", limit: 1 });
		expect(one.events.map((entry) => entry.seq)).toEqual([second]);
		expect(one.truncated).toBe(true);
		await store.queue(foreignJob(200), LATER);
		const idle = await store.eventsSince({
			accountId: "hobo-labs",
			after: all.cursor,
			limit: 10,
		});
		expect(idle.events).toEqual([]);
		expect(idle.cursor).toBe(all.cursor);
		void theirs;
	});

	it("binds the runner's job and fences it from re-reservation", async () => {
		const { store } = harness;
		const lease = await store.reserve(account(), job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		const running = job(1, "in_progress");
		running.runnerName = lease.runnerName;
		await store.observe(running, NOW, revision);
		expect((await store.get(lease.id))?.actualJobId).toBe(1);
		expect((await store.assignedJob(job(1)))?.leaseId).toBe(lease.id);
		const completed = job(1, "completed");
		completed.runnerName = lease.runnerName;
		await store.observe(completed, LATER, revision);
		expect(await store.assignedJob(job(1))).toBe(undefined);
		await store.queue(job(1), LATER, revision);
		expect(await store.pendingJobs()).toEqual([]);
	});

	it("withdraws isolated demand without re-queueing when a foreign runner wins", async () => {
		const { store } = harness;
		await store.queue(job(1), NOW, revision);
		const lease = await store.reserve(account(), job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
			},
			"ci.DispatchRequested",
			NOW,
			revision,
		);
		expect(await store.withdrawQueuedJob(job(1), NOW, revision)).toBe(true);
		expect((await store.get(lease.id))?.state).toBe("cancelled");
		expect(await store.pendingJobs()).toEqual([]);
		expect(await store.activeLeases()).toEqual([]);
	});

	it("requeues aborted isolated leases under the next generation and settles box leases", async () => {
		const { store } = harness;
		const first = await store.reserve(account(), job(1), NOW, revision);
		if (!first) throw new Error("reservation");
		await store.abortIsolatedAndRequeue(first.id, job(1), NOW);
		expect((await store.get(first.id))?.state).toBe("cancelled");
		expect((await store.pendingJobs()).map((entry) => entry.id)).toEqual([1]);
		const second = await store.reserve(account(), job(1), NOW, revision);
		if (!second) throw new Error("re-reservation");
		expect(second.id).toBe(
			relayLeaseId({ repositoryId: 101, jobId: 1, runAttempt: 1 }, 1),
		);
		expect(second.budgetAdmissionAttempt).toBe(2);
		expect(
			await store.settleObserved(second.id, 0, 1, LATER, undefined, LATER, {
				state: "running",
				hostRunId: 0,
				runnerId: 0,
			}),
		).toBe(undefined);
		const settled = await store.settle(second.id, 0, 3, LATER, job(1));
		expect(settled).toMatchObject({ state: "completed", billedMinutes: 3 });
		expect((await store.pendingJobs()).map((entry) => entry.id)).toEqual([1]);
		expect(await store.settle(second.id, 0, 3, LATER)).toBe(undefined);
		const third = await store.reserve(account(), job(1), LATER, revision);
		expect(third?.id).toBe(
			relayLeaseId({ repositoryId: 101, jobId: 1, runAttempt: 1 }, 2),
		);
	});

	it("dedupes and replay-guards webhook deliveries and hands new ones to intake", async () => {
		const { store, intake } = harness;
		const body = '{"action":"queued","n":1}';
		expect(await store.acceptWebhook(delivery("d-1", body))).toEqual({
			duplicate: false,
		});
		expect(await store.hasWebhook("d-1")).toBe(true);
		expect(await store.hasWebhook("d_bad")).toBe(false);
		expect(await store.acceptWebhook(delivery("d-1", body))).toEqual({
			duplicate: true,
		});
		await expect(
			store.acceptWebhook(delivery("d-1", '{"other":true}')),
		).rejects.toThrow(/conflicting webhook delivery id/);
		expect(await store.acceptWebhook(delivery("d-2", body))).toEqual({
			duplicate: true,
		});
		await expect(store.acceptWebhook(delivery("bad_id", body))).rejects.toThrow(
			/invalid webhook envelope/,
		);
		await store.acceptIgnoredWebhook(delivery("d-ignored", '{"x":1}'));
		expect(intake.map((entry) => entry.deliveryId)).toEqual(["d-1"]);
		expect(Buffer.from(intake[0]?.rawBody ?? []).toString()).toBe(body);
		// No inbox: there is nothing to claim; the queue pushes deliveries.
		expect(await store.claimWebhook()).toBe(undefined);
	});

	it("lets GitHub redeliver a delivery intake refused", async () => {
		const failing = openRelayCache(configuration(), {
			intake: {
				enqueue: async () => {
					throw new Error("queue unavailable");
				},
			},
		});
		await expect(
			failing.store.acceptWebhook(delivery("d-9", '{"action":"queued"}')),
		).rejects.toThrow(/queue unavailable/);
		expect(await failing.store.hasWebhook("d-9")).toBe(false);
	});
});
