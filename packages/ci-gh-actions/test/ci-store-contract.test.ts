import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type CiEventPage,
	type Configuration,
	ConfigurationSchema,
	ConnectionSchema,
	EVENT_SCAN_SPAN,
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

	it("says when a read stopped short of the journal's end, whoever filled it", async () => {
		if (!pool) throw new Error("postgres pool unavailable");
		const partition = `contract-${randomUUID()}`;
		const store = new PostgresCiStore(pool, partition);
		await store.configuration();
		// Every partition of the table shares one sequence. Another partition's
		// rows move this one's positions far apart; they are not this journal's
		// length, and a read from its start must not crawl through them.
		await pool.query(
			`INSERT INTO hobo_ci_events(partition_id,body)
			 SELECT $1, '{"type":"ci.ControlRecordUpdated","accountId":"hobo-labs","at":"${NOW}"}'
			 FROM generate_series(1,$2::int)`,
			[`${partition}-other`, 3 * EVENT_SCAN_SPAN],
		);
		await store.putControlRecord("first", "hobo-labs", "{}", NOW);
		const start = await store.eventsSince({
			accountId: "hobo-labs",
			after: 0,
			limit: 10,
		});
		expect(start.events.length).toBe(1);
		expect(start.more).toBe(false);
		expect(
			(await store.eventsSince({ accountId: "hobo-labs", limit: 10 }))
				.truncated,
		).toBe(false);
		// A neighbour's rows in this partition: more than two scans cover.
		await pool.query(
			`INSERT INTO hobo_ci_events(partition_id,body)
			 SELECT $1, '{"type":"ci.ControlRecordUpdated","accountId":"other-co","at":"${NOW}"}'
			 FROM generate_series(1,$2::int)`,
			[partition, 2 * EVENT_SCAN_SPAN + 500],
		);
		await store.putControlRecord("last", "hobo-labs", "{}", NOW);
		const seen: number[] = [];
		const cut: boolean[] = [];
		let after = 0;
		for (;;) {
			const page = await store.eventsSince({
				accountId: "hobo-labs",
				after,
				limit: 10,
			});
			seen.push(...page.events.map((entry) => entry.seq));
			cut.push(page.more);
			expect(page.cursor).toBeGreaterThan(after);
			after = page.cursor;
			if (!page.more) break;
		}
		// Both of the account's events, with at least one empty scan between
		// them that still said "more".
		expect(seen.length).toBe(2);
		expect(cut.length).toBeGreaterThanOrEqual(3);
		expect(cut.at(-1)).toBe(false);
		const newest = await store.eventsSince({
			accountId: "hobo-labs",
			limit: 10,
		});
		expect(newest.events.map((entry) => entry.seq)).toEqual([seen[1]]);
		expect(newest.truncated).toBe(true);
		expect(newest.cursor).toBe(after);
	});
});
