import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type CiEventPage,
	type Configuration,
	ConfigurationSchema,
	ConnectionSchema,
	type EventCursor,
	eventJob,
	type Job,
	JobSchema,
	type LeaseEventsQuery,
	OfferSchema,
	type SequencedCiEvent,
} from "@hobo/ci";
import { PostgresCiStore } from "@hobo/ci/postgres";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import pg from "pg";
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	parsePinnedImage,
	pinnedContainerImages,
} from "../contracts/pinned-container-images.js";
import type { HostedInboxStore } from "../src/hosted-runtime.js";
import {
	createIsolatedContainerController,
	type IsolatedWorkerStore,
} from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import { startContainer } from "./fixtures/start-container.js";

/** One behavioural contract for every engine behind the box worker and hosted runtime. */
type ContractStore = HostedInboxStore &
	IsolatedWorkerStore & {
		configure(
			config: Configuration,
			revision: number,
			at: string,
		): Promise<{ revision: number }>;
		putControlRecord(
			key: string,
			accountId: string,
			bodyJson: string,
			at: string,
		): Promise<void>;
		putControlRecordMonotonic(
			key: string,
			accountId: string,
			bodyJson: string,
			at: string,
			terminalStatus: string,
		): Promise<{ bodyJson: string } | undefined>;
		controlRecord(key: string): Promise<{ bodyJson: string } | undefined>;
		hasWebhook(deliveryId: string): Promise<boolean>;
		eventsSince(cursor: EventCursor): Promise<CiEventPage>;
		leaseEvents(query: LeaseEventsQuery): Promise<SequencedCiEvent[]>;
		journalHead(): Promise<number>;
	};

const NOW = "2026-11-02T12:00:00.000Z";
const LATER = "2026-11-02T12:05:00.000Z";

function configuration(): Configuration {
	return create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "hobo-labs",
				budgetMicros: 0,
				maxRuntimeMinutes: 30,
				startupMinutes: 5,
				offers: [
					create(OfferSchema, {
						id: "box-isolated",
						provider: "kubernetes",
						providerAccountId: "box",
						enabled: true,
						runsOn: "hobo-isolated-worker",
						backend: "isolated-container",
						freeMinutes: 0,
						priceMicrosPerMinute: 0,
						budgetMicros: 0,
						concurrency: 2,
						observedAt: "2026-11-02T00:00:00Z",
						validUntil: "2026-12-31T23:59:59Z",
						sourceUrl: "https://example.test/box-evidence",
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
				isolatedOnly: true,
				acceptAllMatchingRepositoryJobs: true,
				trustedRepositoryAcknowledged: true,
				publicRepositoryAcknowledged: true,
			}),
		],
	});
}

function job(id: number, action = "queued"): Job {
	return create(JobSchema, {
		id,
		runId: 900,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "Org/Repo",
		labels: ["hobo"],
		action,
		isolatedRequired: true,
	});
}

/** The fixture account plus a second one with its own repository and box. */
function twoAccounts(): Configuration {
	const config = configuration();
	const [account] = config.accounts;
	const [connection] = config.connections;
	if (!account || !connection) throw new Error("fixture account");
	return create(ConfigurationSchema, {
		accounts: [
			account,
			create(AccountSchema, {
				...account,
				id: "other-co",
				offers: account.offers.map((offer) =>
					create(OfferSchema, { ...offer, providerAccountId: "other-box" }),
				),
			}),
		],
		connections: [
			connection,
			create(ConnectionSchema, {
				...connection,
				accountId: "other-co",
				repository: "Other/Repo",
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
	other.repository = "Other/Repo";
	return other;
}

function delivery(deliveryId: string, body: string, receivedAt = NOW) {
	return {
		deliveryId,
		event: "workflow_job",
		installationId: 10,
		repositoryId: 101,
		rawBody: Buffer.from(body),
		receivedAt,
	};
}

function storeContract(
	name: string,
	open: () => Promise<{ store: ContractStore; close: () => Promise<void> }>,
) {
	describe(`${name} CI store contract`, () => {
		let store: ContractStore;
		let close: () => Promise<void> = async () => undefined;
		let revision = 0;
		beforeEach(async () => {
			await close();
			({ store, close } = await open());
			revision = (await store.configure(configuration(), 0, NOW)).revision;
		});
		afterAll(async () => {
			await close();
		});

		it("compare-and-swaps configuration revisions", async () => {
			expect(revision).toBe(1);
			expect((await store.configuration())?.revision).toBe(1);
			await expect(store.configure(configuration(), 0, NOW)).rejects.toThrow(
				/configuration revision conflict/,
			);
			expect(await store.ready()).toBe(true);
			const snapshot = await store.policySnapshot();
			expect(snapshot.state?.revision).toBe(1);
			expect(snapshot.policies).toEqual([]);
		});

		it("fences and retires an interrupted isolated create", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("missing account");
			const demand = job(1);
			await store.queue(demand, NOW, revision);
			const lease = await store.reserve(account, demand, NOW, revision);
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

		it("round-trips control records", async () => {
			await store.putControlRecord(
				"contract:note",
				"hobo-labs",
				'{"a":1}',
				NOW,
			);
			expect((await store.controlRecord("contract:note"))?.bodyJson).toBe(
				'{"a":1}',
			);
			await expect(
				store.putControlRecord("contract:note", "other", '{"a":2}', NOW),
			).rejects.toThrow(/another account/);
		});

		it("keeps a control record's terminal status against a late earlier writer", async () => {
			const put = (status: string, step: number) =>
				store.putControlRecordMonotonic(
					"contract:operation",
					"hobo-labs",
					JSON.stringify({ status, step }),
					NOW,
					"ready",
				);
			expect((await put("planned", 1))?.bodyJson).toBe(
				'{"status":"planned","step":1}',
			);
			expect((await put("applied", 2))?.bodyJson).toBe(
				'{"status":"applied","step":2}',
			);
			expect((await put("ready", 3))?.bodyJson).toBe(
				'{"status":"ready","step":3}',
			);
			// A slower request that still carries the earlier status loses.
			expect((await put("applied", 4))?.bodyJson).toBe(
				'{"status":"ready","step":3}',
			);
			expect((await store.controlRecord("contract:operation"))?.bodyJson).toBe(
				'{"status":"ready","step":3}',
			);
			expect((await put("ready", 5))?.bodyJson).toBe(
				'{"status":"ready","step":5}',
			);
			await expect(
				store.putControlRecordMonotonic(
					"contract:operation",
					"other",
					'{"status":"ready"}',
					NOW,
					"ready",
				),
			).rejects.toThrow(/another account/);
		});
		it("dedupes queued demand", async () => {
			await store.queue(job(1), NOW, revision);
			await store.queue(job(1), NOW, revision);
			expect((await store.pendingJobs()).map((entry) => entry.id)).toEqual([1]);
			await expect(store.queue(job(2), NOW, revision + 1)).rejects.toThrow(
				/configuration revision conflict/,
			);
		});

		it("reserves isolated demand on the zero-price box offer", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			await store.queue(job(1), NOW, revision);
			const lease = await store.reserve(account, job(1), NOW, revision);
			expect(lease).toMatchObject({
				provider: "kubernetes",
				offerId: "box-isolated",
				state: "reserved",
				jobId: 1,
				reservedPaidMicros: 0,
				runnerName: `hobo-${lease?.id}`,
			});
			expect(await store.pendingJobs()).toEqual([]);
			expect((await store.reserve(account, job(1), NOW, revision))?.id).toBe(
				lease?.id,
			);
			expect((await store.activeLeases()).map((entry) => entry.id)).toEqual([
				lease?.id,
			]);
			expect((await store.accountLeases("hobo-labs")).length).toBe(1);
			expect((await store.get(lease?.id ?? ""))?.state).toBe("reserved");
			// Offer concurrency is two: a third job waits for capacity.
			await store.reserve(account, job(2), NOW, revision);
			expect(await store.reserve(account, job(3), NOW, revision)).toBe(
				undefined,
			);
		});

		it("fails closed for unbound repositories", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			const foreign = job(1);
			foreign.repositoryId = 999;
			await expect(store.reserve(account, foreign, NOW)).rejects.toThrow(
				/connection revoked/,
			);
		});

		it("fences transitions by state and exposes the latest intent", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			const lease = await store.reserve(account, job(1), NOW, revision);
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
			expect(intents.map((event) => [event.leaseId, event.type])).toEqual([
				[lease.id, "ci.DispatchRequested"],
			]);
			expect(await store.latestLeaseIntents([])).toEqual([]);
		});

		it("reads an account's events after a cursor, in log order", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			await store.queue(job(1), NOW, revision);
			const lease = await store.reserve(account, job(1), NOW, revision);
			if (!lease) throw new Error("reservation");
			const newest = await store.eventsSince({
				accountId: "hobo-labs",
				limit: 10,
			});
			// A job queued before any lease names no account: it is the
			// account's through the repository connection.
			expect(newest.events.map((entry) => entry.event?.type)).toEqual([
				"ci.JobQueued",
				"ci.LeaseReserved",
			]);
			const positions = newest.events.map((entry) => entry.seq);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			expect(new Set(positions).size).toBe(positions.length);
			expect(newest.cursor).toBe(positions.at(-1));
			expect(await store.journalHead()).toBe(newest.cursor);
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
			expect(next.cursor).toBeGreaterThan(newest.cursor);
			// One event at a time from the start walks the same log without a
			// skip or a repeat, and the newest-first read keeps log order.
			const walked: string[] = [];
			let after = 0;
			for (;;) {
				const page = await store.eventsSince({
					accountId: "hobo-labs",
					after,
					limit: 1,
				});
				if (page.events.length === 0) break;
				expect(page.events.length).toBe(1);
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

		it("reads a lease's events by its id, for its own account only", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			const first = await store.reserve(account, job(1), NOW, revision);
			const second = await store.reserve(account, job(2), NOW, revision);
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
			expect(events.every((entry) => entry.event?.leaseId === first.id)).toBe(
				true,
			);
			// The newest come first to be kept; they are returned in journal order.
			expect(
				(
					await store.leaseEvents({
						accountId: "hobo-labs",
						leaseId: first.id,
						limit: 1,
					})
				).map((entry) => entry.event?.type),
			).toEqual(["ci.DispatchRequested"]);
			// Another account asking by the same id finds nothing.
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

		it("keeps a job event with the account that owned the repository when it was written", async () => {
			await store.queue(job(1), NOW, revision);
			// The repository's connection moves to another account.
			const moved = twoAccounts();
			const [, theirs] = moved.connections;
			if (!theirs) throw new Error("fixture connection");
			theirs.repository = "Org/Repo";
			theirs.repositoryId = 101;
			theirs.installationId = 10;
			moved.connections.splice(0, 1);
			revision = (await store.configure(moved, revision, LATER)).revision;
			const completed = job(1, "completed");
			await store.observe(completed, LATER, revision);
			await store.queue(job(2), LATER, revision);
			const jobs = async (accountId: string) =>
				(
					await store.eventsSince({ accountId, after: 0, limit: 50 })
				).events.map((entry) => [
					entry.event?.type,
					entry.event ? eventJob(entry.event)?.id : undefined,
				]);
			// What was journalled under the first owner stays the first owner's;
			// the new owner reads only what happened after the move.
			expect(await jobs("hobo-labs")).toEqual([["ci.JobQueued", 1]]);
			expect(await jobs("other-co")).toEqual([
				["ci.JobCompleted", 1],
				["ci.JobQueued", 2],
			]);
		});

		it("never reads another account's events", async () => {
			const config = twoAccounts();
			revision = (await store.configure(config, revision, NOW)).revision;
			const [mine, theirs] = config.accounts;
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
				const page = await store.eventsSince({
					accountId,
					after: 0,
					limit: 50,
				});
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
			// A configuration change belongs to the partition, not to an account.
			const stranger = await store.eventsSince({
				accountId: "nobody",
				after: 0,
				limit: 50,
			});
			expect(stranger.events).toEqual([]);
		});

		it("reads exactly an account's events, whatever another account journals", async () => {
			// Two of the account's events with a neighbour's between and after
			// them, and the partition's own (configuration) before them all.
			await store.putControlRecord("mine-1", "hobo-labs", "{}", NOW);
			for (let index = 0; index < 25; index += 1)
				await store.putControlRecord(`theirs-${index}`, "other-co", "{}", NOW);
			await store.putControlRecord("mine-2", "hobo-labs", "{}", NOW);
			await store.putControlRecord("theirs-last", "other-co", "{}", NOW);
			const head = await store.journalHead();

			// Everything of the account's in one read, and no "more": the only
			// bound is the page.
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
			// The cursor is the account's own last event, not the journal's end.
			const [first, second] = all.events.map((entry) => entry.seq);
			expect(all.cursor).toBe(second);
			expect(all.cursor).toBeLessThan(head);

			// A page of one is cut by its size and resumes after its event.
			const page = await store.eventsSince({
				accountId: "hobo-labs",
				after: 0,
				limit: 1,
			});
			expect(page.events.map((entry) => entry.seq)).toEqual([first]);
			expect(page.cursor).toBe(first);
			expect(page.more).toBe(true);
			const rest = await store.eventsSince({
				accountId: "hobo-labs",
				after: page.cursor,
				limit: 1,
			});
			expect(rest.events.map((entry) => entry.seq)).toEqual([second]);
			expect(rest.more).toBe(false);

			// The newest read holds both; asked for one, it says an older one
			// is left, and hands back the same cursor either way.
			const newest = await store.eventsSince({
				accountId: "hobo-labs",
				limit: 10,
			});
			expect(newest.events).toEqual(all.events);
			expect(newest.truncated).toBe(false);
			expect(newest.cursor).toBe(second);
			const one = await store.eventsSince({ accountId: "hobo-labs", limit: 1 });
			expect(one.events.map((entry) => entry.seq)).toEqual([second]);
			expect(one.truncated).toBe(true);
			expect(one.cursor).toBe(second);

			// While only the neighbour journals, every read of this account
			// returns nothing new and the cursor it was given.
			await store.putControlRecord("theirs-more", "other-co", "{}", LATER);
			expect(await store.journalHead()).toBeGreaterThan(head);
			const idle = await store.eventsSince({
				accountId: "hobo-labs",
				after: all.cursor,
				limit: 10,
			});
			expect(idle.events).toEqual([]);
			expect(idle.cursor).toBe(all.cursor);
			expect(idle.more).toBe(false);
			expect(
				(await store.eventsSince({ accountId: "hobo-labs", limit: 10 })).cursor,
			).toBe(all.cursor);
			// An account with nothing in the journal reads on from its start.
			const nobody = await store.eventsSince({
				accountId: "nobody",
				limit: 10,
			});
			expect(nobody.events).toEqual([]);
			expect(nobody.cursor).toBe(0);
			expect(nobody.truncated).toBe(false);
		});

		it("binds the runner's job and fences it from re-reservation", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			const lease = await store.reserve(account, job(1), NOW, revision);
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

		it("requeues aborted isolated leases and settles box leases", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			const first = await store.reserve(account, job(1), NOW, revision);
			if (!first) throw new Error("reservation");
			await store.abortIsolatedAndRequeue(first.id, job(1), NOW);
			expect((await store.get(first.id))?.state).toBe("cancelled");
			expect((await store.pendingJobs()).map((entry) => entry.id)).toEqual([1]);
			const second = await store.reserve(account, job(1), NOW, revision);
			if (!second) throw new Error("re-reservation");
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
		});

		it("dedupes, claims, acknowledges and replays-guards webhook deliveries", async () => {
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
			// Same signed bytes under a new id are a replay, not new work.
			expect(await store.acceptWebhook(delivery("d-2", body))).toEqual({
				duplicate: true,
			});
			await expect(
				store.acceptWebhook(delivery("bad_id", body)),
			).rejects.toThrow(/invalid webhook envelope/);
			await store.acceptIgnoredWebhook(delivery("d-ignored", '{"x":1}'));
			const claim = await store.claimWebhook(NOW, 60_000);
			expect(claim).toMatchObject({ deliveryId: "d-1", event: "workflow_job" });
			expect(Buffer.from(claim?.rawBody ?? []).toString()).toBe(body);
			expect(await store.claimWebhook(NOW, 60_000)).toBe(undefined);
			expect(await store.ackWebhook("d-1", "wrong-token")).toBe(false);
			expect(await store.ackWebhook("d-1", claim?.token ?? "")).toBe(true);
			expect(await store.claimWebhook(LATER, 60_000)).toBe(undefined);
		});

		it("backs off failed deliveries and quarantines poison ones", async () => {
			await store.acceptWebhook(delivery("poison", '{"poison":true}'));
			let at = Date.parse(NOW);
			let outcome = "";
			for (let attempt = 1; attempt <= 8; attempt++) {
				const claim = await store.claimWebhook(
					new Date(at).toISOString(),
					1_000,
				);
				expect(claim?.deliveryId).toBe("poison");
				outcome = await store.failWebhook(
					"poison",
					claim?.token ?? "",
					new Date(at).toISOString(),
				);
				if (outcome === "retry")
					expect(
						await store.claimWebhook(new Date(at).toISOString(), 1_000),
					).toBe(undefined);
				at += 301_000;
			}
			expect(outcome).toBe("quarantined");
			expect(await store.claimWebhook(new Date(at).toISOString(), 1_000)).toBe(
				undefined,
			);
			expect(await store.failWebhook("poison", "stale", NOW)).toBe("stale");
		});
	});
}

let sqliteRoot = "";
beforeAll(() => {
	sqliteRoot = mkdtempSync(join(tmpdir(), "hobo-ci-store-contract-"));
});
afterAll(() => {
	rmSync(sqliteRoot, { recursive: true, force: true });
});

storeContract("SqliteCiStore", async () => {
	const store = new SqliteCiStore(join(sqliteRoot, `${randomUUID()}.sqlite`));
	return { store, close: async () => store.close() };
});

it("reads a lease's events on SQLite through the lease index, never by walking the journal", async () => {
	const path = join(sqliteRoot, `${randomUUID()}.sqlite`);
	const store = new SqliteCiStore(path);
	const other = new DatabaseSync(path);
	try {
		const { revision } = await store.configure(configuration(), 0, NOW);
		const account = configuration().accounts[0];
		if (!account) throw new Error("fixture account");
		const lease = await store.reserve(account, job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		const query = { accountId: "hobo-labs", leaseId: lease.id, limit: 20 };
		expect(
			(await store.leaseEvents(query)).map((entry) => entry.event?.type),
		).toEqual(["ci.LeaseReserved"]);
		// The read is bound to the index: SQLite's own plan for it searches the
		// index for the lease and never scans the journal.
		const plan = other
			.prepare(
				"EXPLAIN QUERY PLAN SELECT seq, body FROM events INDEXED BY events_lease_type WHERE json_extract(body,'$.leaseId')=? AND json_extract(body,'$.accountId')=? ORDER BY seq DESC LIMIT ?",
			)
			.all(lease.id, "hobo-labs", 20)
			.map((step) => String(step.detail));
		expect(plan.join("\n")).toMatch(
			/SEARCH events USING INDEX events_lease_type/,
		);
		expect(plan.join("\n")).not.toMatch(/SCAN events/);
		// Without the index the read fails. It does not quietly fall back to a
		// walk of the whole journal, which would stop the host while it ran.
		other.exec("DROP INDEX events_lease_type");
		await expect(store.leaseEvents(query)).rejects.toThrow(/no such index/);
	} finally {
		other.close();
		store.close();
	}
});

it("reads an account's events on SQLite through the account index, never by walking the journal", async () => {
	const path = join(sqliteRoot, `${randomUUID()}.sqlite`);
	const store = new SqliteCiStore(path);
	const other = new DatabaseSync(path);
	try {
		await store.putControlRecord("first", "hobo-labs", "{}", NOW);
		const mine =
			"SELECT seq, body FROM events INDEXED BY events_account_seq WHERE json_extract(body,'$.accountId')=?";
		// SQLite's own plan for the newest read and for the cursor read: a
		// search of the account index, already in journal order.
		for (const [statement, values] of [
			[`${mine} ORDER BY seq DESC LIMIT ?`, ["hobo-labs", 11]],
			[`${mine} AND seq>? ORDER BY seq LIMIT ?`, ["hobo-labs", 0, 11]],
		] as const) {
			const plan = other
				.prepare(`EXPLAIN QUERY PLAN ${statement}`)
				.all(...values)
				.map((step) => String(step.detail))
				.join("\n");
			expect(plan).toMatch(/SEARCH events USING INDEX events_account_seq/);
			expect(plan).not.toMatch(/SCAN events|TEMP B-TREE/);
		}
		expect(
			(await store.eventsSince({ accountId: "hobo-labs", after: 0, limit: 10 }))
				.events.length,
		).toBe(1);
		// Without the index the read fails. It does not quietly fall back to a
		// walk of the whole journal, which would stop the host while it ran.
		other.exec("DROP INDEX events_account_seq");
		await expect(
			store.eventsSince({ accountId: "hobo-labs", after: 0, limit: 10 }),
		).rejects.toThrow(/no such index/);
		await expect(
			store.eventsSince({ accountId: "hobo-labs", limit: 10 }),
		).rejects.toThrow(/no such index/);
	} finally {
		other.close();
		store.close();
	}
});

function dockerAvailable(): boolean {
	if (process.env.HOBO_FUZZ_DOCKER === "0") return false;
	if (!existsSync("/var/run/docker.sock")) return false;
	return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

// A real server, never a shared or production database. Without a Docker
// engine the Postgres half is skipped; HOBO_CI_TEST_POSTGRES names an
// already-running disposable server instead of starting a container.
const externalPostgres = process.env.HOBO_CI_TEST_POSTGRES;
const postgresAvailable = !!externalPostgres || dockerAvailable();
let container: StartedTestContainer | undefined;
let pool: pg.Pool | undefined;

describe.runIf(postgresAvailable)("Postgres engine", () => {
	beforeAll(async () => {
		let connectionString = externalPostgres;
		if (!connectionString) {
			const { repository, digest } = parsePinnedImage(
				pinnedContainerImages.postgres17Alpine,
			);
			const password = randomUUID();
			container = await startContainer(() =>
				new GenericContainer(`${repository}@${digest}`)
					.withEnvironment({
						POSTGRES_DB: "contract",
						POSTGRES_USER: "contract",
						POSTGRES_PASSWORD: password,
					})
					.withWaitStrategy(
						Wait.forLogMessage(
							/database system is ready to accept connections/,
							2,
						),
					)
					.withExposedPorts(5432),
			);
			connectionString = `postgresql://contract:${password}@${container.getHost()}:${container.getMappedPort(5432)}/contract`;
		}
		pool = new pg.Pool({ connectionString, max: 4 });
	}, 180_000);
	afterAll(async () => {
		await pool?.end();
		await container?.stop();
	});

	storeContract("PostgresCiStore", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		return {
			store: new PostgresCiStore(pool, `contract-${randomUUID()}`),
			close: async () => undefined,
		};
	});

	it("lets an observer read while a mutation holds the partition lock", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		const partition = `contract-${randomUUID()}`;
		const store = new PostgresCiStore(pool, partition);
		const { revision } = await store.configure(configuration(), 0, NOW);
		const account = configuration().accounts[0];
		if (!account) throw new Error("fixture account");
		await store.queue(job(2), NOW, revision);
		const lease = await store.reserve(account, job(1), NOW, revision);
		if (!lease) throw new Error("reservation");
		// A long mutation: the partition's lock row is held, as every write
		// and every ordinary read of the store takes it.
		const writer = await pool.connect();
		try {
			await writer.query("BEGIN");
			await writer.query(
				"SELECT 1 FROM hobo_ci_partitions WHERE id=$1 FOR UPDATE",
				[partition],
			);
			let queued = false;
			const behindTheLock = store.get(lease.id).then(() => {
				queued = true;
			});
			const observer = store.observer();
			expect((await observer.get(lease.id))?.id).toBe(lease.id);
			expect((await observer.configuration())?.revision).toBe(revision);
			expect(await observer.journalHead()).toBeGreaterThan(0);
			expect(
				(await observer.accountLeases("hobo-labs")).map((entry) => entry.id),
			).toEqual([lease.id]);
			expect((await observer.pendingJobs()).map((entry) => entry.id)).toEqual([
				2,
			]);
			expect(await observer.quarantinedWebhooks("hobo-labs", revision)).toEqual(
				[],
			);
			await expect(
				observer.quarantinedWebhooks("hobo-labs", revision + 1),
			).rejects.toThrow(/configuration revision conflict/);
			expect(
				(
					await observer.eventsSince({ accountId: "hobo-labs", limit: 10 })
				).events.map((entry) => entry.event?.type),
			).toEqual(["ci.JobQueued", "ci.LeaseReserved"]);
			expect(
				(
					await observer.leaseEvents({
						accountId: "hobo-labs",
						leaseId: lease.id,
						limit: 10,
					})
				).map((entry) => entry.event?.type),
			).toEqual(["ci.LeaseReserved"]);
			// The store's own read is still waiting for the lock.
			expect(queued).toBe(false);
			await writer.query("COMMIT");
			await behindTheLock;
			expect(queued).toBe(true);
		} finally {
			await writer.query("ROLLBACK").catch(() => undefined);
			writer.release();
		}
	});

	it("reads the configuration no more often to record who owns a job", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		const real = pool;
		const statements: string[] = [];
		// The store's pool, with each statement a transaction runs noted.
		const counting = {
			query: (text: string, values?: readonly string[]) =>
				real.query(text, values ? [...values] : undefined),
			connect: async () => {
				const client = await real.connect();
				return {
					query: (text: string, values?: readonly (string | number)[]) => {
						statements.push(text);
						return client.query(text, values ? [...values] : undefined);
					},
					release: () => client.release(),
				};
			},
		};
		const store = new PostgresCiStore(
			// SAFETY: the store uses only `query` and `connect` of its pool, and
			// only `query` and `release` of a client; both are passed through.
			counting as pg.Pool,
			`contract-${randomUUID()}`,
		);
		const { revision } = await store.configure(configuration(), 0, NOW);
		const reads = async (run: () => Promise<void>) => {
			statements.length = 0;
			await run();
			return statements.filter((text) =>
				text.includes("FROM hobo_ci_configuration"),
			).length;
		};
		// Queueing reads it to check the revision and to find the binding, as
		// it did before job events named their owner: not once more for that.
		expect(await reads(() => store.queue(job(1), NOW, revision))).toBe(2);
		const completed = job(1, "completed");
		expect(await reads(() => store.observe(completed, LATER, revision))).toBe(
			1,
		);
		// A job whose queue deadline has passed, expired before it was queued.
		const overdue = job(3);
		overdue.queueDeadlineAt = NOW;
		expect(
			await reads(async () => {
				expect(await store.expireQueued(overdue, LATER, revision)).toBe(true);
			}),
		).toBe(1);
		expect(
			(
				await store.eventsSince({ accountId: "hobo-labs", after: 0, limit: 10 })
			).events.map((entry) => [entry.event?.type, entry.event?.accountId]),
		).toEqual([
			["ci.JobQueued", "hobo-labs"],
			["ci.JobCompleted", "hobo-labs"],
			["ci.JobExpired", "hobo-labs"],
		]);
	});

	/** Journal rows as a release that does not stamp the account writes them. */
	const unstamped = (
		partition: string,
		body: string,
		count: number,
	): Promise<pg.QueryResult> => {
		if (!pool) throw new Error("postgres pool unavailable");
		return pool.query(
			"INSERT INTO hobo_ci_events(partition_id,body) SELECT $1,$2 FROM generate_series(1,$3::int)",
			[partition, body, count],
		);
	};
	const stampedAs = async (partition: string): Promise<[string, number][]> => {
		if (!pool) throw new Error("postgres pool unavailable");
		return (
			await pool.query<{ account: string; rows: string }>(
				"SELECT coalesce(account_id,'(unstamped)') AS account, count(*)::text AS rows FROM hobo_ci_events WHERE partition_id=$1 GROUP BY 1 ORDER BY 1",
				[partition],
			)
		).rows.map((row) => [row.account, Number(row.rows)]);
	};
	const controlRecord = (accountId: string) =>
		`{"type":"ci.ControlRecordUpdated","accountId":"${accountId}","at":"${NOW}"}`;

	it("reads exactly an account's events behind another tenant's volume, through the account index", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		const real = pool;
		const partition = `contract-${randomUUID()}`;
		const reads: { text: string; values: (string | number)[] }[] = [];
		// The store's pool, with each statement it runs outside a transaction
		// noted: the event reads are such statements.
		const noting = {
			query: (text: string, values?: readonly (string | number)[]) => {
				reads.push({ text, values: values ? [...values] : [] });
				return real.query(text, values ? [...values] : undefined);
			},
			connect: () => real.connect(),
		};
		const store = new PostgresCiStore(
			// SAFETY: the store uses only `query` and `connect` of its pool;
			// both are passed through to the real pool.
			noting as pg.Pool,
			partition,
		);
		// Start-up's own fill-in has nothing to do here; wait for it so that
		// the rows below stay as they are written.
		await store.stampEventAccounts();
		await store.putControlRecord("first", "hobo-labs", "{}", NOW);
		// Every partition of the table shares one sequence, and so does every
		// account of this partition: three old scan spans of another
		// partition's rows, then more than two of a neighbour's in this one.
		await unstamped(`${partition}-other`, controlRecord("hobo-labs"), 30_000);
		await real.query(
			"INSERT INTO hobo_ci_events(partition_id,account_id,body) SELECT $1,'other-co',$2 FROM generate_series(1,$3::int)",
			[partition, controlRecord("other-co"), 20_500],
		);
		await store.putControlRecord("last", "hobo-labs", "{}", NOW);
		await real.query("ANALYZE hobo_ci_events");

		reads.length = 0;
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
		const [first, last] = all.events.map((entry) => entry.seq);
		expect(all.cursor).toBe(last);
		const newest = await store.eventsSince({
			accountId: "hobo-labs",
			limit: 10,
		});
		expect(newest.events).toEqual(all.events);
		expect(newest.truncated).toBe(false);
		expect(newest.cursor).toBe(last);
		// Only the page's size cuts either read short.
		const page = await store.eventsSince({
			accountId: "hobo-labs",
			after: 0,
			limit: 1,
		});
		expect(page.events.map((entry) => entry.seq)).toEqual([first]);
		expect(page.more).toBe(true);
		const one = await store.eventsSince({ accountId: "hobo-labs", limit: 1 });
		expect(one.events.map((entry) => entry.seq)).toEqual([last]);
		expect(one.truncated).toBe(true);
		// The neighbour's own feed is cut by the page and by nothing else.
		const theirs = await store.eventsSince({
			accountId: "other-co",
			after: 0,
			limit: 500,
		});
		expect(theirs.events.length).toBe(500);
		expect(theirs.more).toBe(true);
		expect(theirs.cursor).toBe(theirs.events.at(-1)?.seq);

		// PostgreSQL's own plan for each event read the store ran, planned
		// without knowing the parameters (the worst case for a LIMIT): both
		// halves go through the account index, and nothing walks the journal
		// by its primary key or scans the table.
		const statements = [...new Set(reads.map((read) => read.text))];
		expect(statements.length).toBe(2);
		const client = await real.connect();
		try {
			await client.query("SET plan_cache_mode = force_generic_plan");
			for (const [index, text] of statements.entries()) {
				const values = reads.find((read) => read.text === text)?.values ?? [];
				// The values are this test's own: a generated partition name, a
				// fixture account and numbers.
				const literals = values.map((value) =>
					Number.isFinite(value) ? String(value) : `'${value}'`,
				);
				await client.query(
					`PREPARE account_read_${index}(${literals
						.map((_, position) => (position < 2 ? "text" : "bigint"))
						.join(",")}) AS ${text}`,
				);
				const plan = (
					await client.query<{ "QUERY PLAN": string }>(
						`EXPLAIN (COSTS OFF) EXECUTE account_read_${index}(${literals.join(",")})`,
					)
				).rows
					.map((row) => row["QUERY PLAN"])
					.join("\n");
				expect(plan.match(/hobo_ci_events_account_seq/g)?.length).toBe(2);
				expect(plan).not.toMatch(/Seq Scan|hobo_ci_events_pkey|partition_seq/);
			}
		} finally {
			await client.query("DEALLOCATE ALL");
			await client.query("RESET plan_cache_mode");
			client.release();
		}
	});

	it("reads exactly while rows are unstamped, and stamps them in batches without the partition lock", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		const partition = `contract-${randomUUID()}`;
		const store = new PostgresCiStore(pool, partition);
		const { revision } = await store.configure(configuration(), 0, NOW);
		// A second instance on the same partition. Each store starts a
		// fill-in of its own when it initialises; both are waited for here,
		// so that the rows below stay as they are written until asked.
		const second = new PostgresCiStore(pool, partition);
		await store.stampEventAccounts();
		await second.stampEventAccounts();
		// What a release that does not stamp the account leaves behind: the
		// account's events, a neighbour's, and a job event from before owners
		// were recorded, which names no account although the repository is
		// connected to one now.
		await unstamped(partition, controlRecord("hobo-labs"), 3);
		await unstamped(partition, controlRecord("other-co"), 250);
		await unstamped(
			partition,
			`{"type":"ci.JobQueued","at":"${NOW}","detail":"{\\"id\\":1,\\"repositoryId\\":101,\\"installationId\\":10}"}`,
			1,
		);
		// The current release keeps writing, stamped, among them.
		await store.queue(job(1), NOW, revision);
		await unstamped(partition, controlRecord("hobo-labs"), 2);
		expect(await stampedAs(partition)).toEqual([
			["", 1],
			["(unstamped)", 256],
			["hobo-labs", 1],
		]);

		const read = async () => {
			const all = await store.eventsSince({
				accountId: "hobo-labs",
				after: 0,
				limit: 4,
			});
			const rest = await store.eventsSince({
				accountId: "hobo-labs",
				after: all.cursor,
				limit: 4,
			});
			const newest = await store.eventsSince({
				accountId: "hobo-labs",
				limit: 4,
			});
			return { all, rest, newest };
		};
		const before = await read();
		// Stamped and unstamped rows of the account, merged in journal order.
		expect(before.all.events.map((entry) => entry.event?.type)).toEqual([
			"ci.ControlRecordUpdated",
			"ci.ControlRecordUpdated",
			"ci.ControlRecordUpdated",
			"ci.JobQueued",
		]);
		expect(before.all.more).toBe(true);
		expect(before.rest.events.length).toBe(2);
		expect(before.rest.more).toBe(false);
		expect(before.newest.events.map((entry) => entry.seq)).toEqual(
			[...before.all.events, ...before.rest.events]
				.map((entry) => entry.seq)
				.slice(-4),
		);
		expect(before.newest.truncated).toBe(true);
		const positions = [...before.all.events, ...before.rest.events].map(
			(entry) => entry.seq,
		);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));

		// Admission's lock row is held for the whole fill-in: it never asks
		// for it, and takes no lock a writer needs.
		const writer = await pool.connect();
		try {
			await writer.query("BEGIN");
			await writer.query(
				"SELECT 1 FROM hobo_ci_partitions WHERE id=$1 FOR UPDATE",
				[partition],
			);
			await expect(
				store.stampEventAccounts({ batchSize: 100, maxBatches: 2 }),
			).resolves.toEqual({ stamped: 200, complete: false });
			// Cut off there, the read is as exact as before.
			expect(await read()).toEqual(before);
			// Two instances at once share what is left; no row is stamped twice.
			const runs = await Promise.all([
				store.stampEventAccounts({ batchSize: 10 }),
				second.stampEventAccounts({ batchSize: 10 }),
			]);
			expect(runs[0].stamped + runs[1].stamped).toBe(56);
			expect(runs.every((run) => run.complete)).toBe(true);
			await writer.query("COMMIT");
		} finally {
			await writer.query("ROLLBACK").catch(() => undefined);
			writer.release();
		}
		// Each row carries the account its own body names; the old job event
		// names none and is given to nobody.
		expect(await stampedAs(partition)).toEqual([
			["", 2],
			["hobo-labs", 6],
			["other-co", 250],
		]);
		expect(await read()).toEqual(before);
		expect(
			(
				await store.eventsSince({ accountId: "hobo-labs", after: 0, limit: 50 })
			).events.filter((entry) => entry.event?.type === "ci.JobQueued").length,
		).toBe(1);
		await expect(store.stampEventAccounts()).resolves.toEqual({
			stamped: 0,
			complete: true,
		});
		await expect(store.stampEventAccounts({ batchSize: 0 })).rejects.toThrow(
			/batch size/,
		);
	});

	it("orders events by journal position where the positions gain a digit", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		// A journal of its own, so its positions start at one: a schema that
		// only this test's connections look in.
		const schema = `lease_order_${randomUUID().replaceAll("-", "")}`;
		await pool.query(`CREATE SCHEMA ${schema}`);
		const own = new pg.Pool({
			...pool.options,
			options: `-c search_path=${schema}`,
			max: 2,
		});
		try {
			const store = new PostgresCiStore(own, "default");
			const { revision } = await store.configure(configuration(), 0, NOW);
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			const lease = await store.reserve(account, job(1), NOW, revision);
			if (!lease) throw new Error("reservation");
			// The lease's first event sits below position 10 and its next one
			// lands on 10 or after: as text, "10" sorts before "2".
			const reserved = await store.journalHead();
			expect(reserved).toBeLessThan(10);
			for (let position = reserved; position < 9; position += 1)
				await store.putControlRecord(`pad-${position}`, "hobo-labs", "{}", NOW);
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
			const events = await store.leaseEvents({
				accountId: "hobo-labs",
				leaseId: lease.id,
				limit: 20,
			});
			expect(events.map((entry) => entry.event?.type)).toEqual([
				"ci.LeaseReserved",
				"ci.DispatchRequested",
			]);
			expect(events.at(-1)?.seq).toBeGreaterThanOrEqual(10);
			// The newest one of the two is the later one.
			expect(
				(
					await store.leaseEvents({
						accountId: "hobo-labs",
						leaseId: lease.id,
						limit: 1,
					})
				).map((entry) => entry.event?.type),
			).toEqual(["ci.DispatchRequested"]);
			// The account's feed crosses the same boundary in order, both ways.
			const feed = await store.eventsSince({
				accountId: "hobo-labs",
				after: 0,
				limit: 50,
			});
			const positions = feed.events.map((entry) => entry.seq);
			expect(positions.length).toBeGreaterThan(2);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			expect(
				(
					await store.eventsSince({ accountId: "hobo-labs", limit: 2 })
				).events.map((entry) => entry.seq),
			).toEqual(positions.slice(-2));
			await store.stampEventAccounts();
		} finally {
			await own.end();
			await pool.query(`DROP SCHEMA ${schema} CASCADE`);
		}
	});

	it("starts stamping a journal an earlier release wrote, without being asked", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		const partition = `contract-${randomUUID()}`;
		// The partition's journal exists before this release first opens it.
		await new PostgresCiStore(pool, `${partition}-schema`).configuration();
		await unstamped(partition, controlRecord("hobo-labs"), 2500);
		const store = new PostgresCiStore(pool, partition);
		// Any use of the store initialises it; nothing here waits for stamping.
		expect(
			(await store.eventsSince({ accountId: "hobo-labs", limit: 5 })).events
				.length,
		).toBe(5);
		await vi.waitFor(
			async () => {
				expect(await stampedAs(partition)).toEqual([["hobo-labs", 2500]]);
			},
			{ timeout: 20_000, interval: 50 },
		);
	});
});
