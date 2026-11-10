import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type Configuration,
	ConfigurationSchema,
	ConnectionSchema,
	type Job,
	JobSchema,
	OfferSchema,
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

		it("withdraws isolated demand without re-queueing when a foreign runner wins", async () => {
			const account = configuration().accounts[0];
			if (!account) throw new Error("fixture account");
			await store.queue(job(1), NOW, revision);
			const lease = await store.reserve(account, job(1), NOW, revision);
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
			expect(
				await store.withdrawQueuedJob(job(1), NOW, revision),
			).toBe(true);
			expect((await store.get(lease.id))?.state).toBe("cancelled");
			expect(await store.pendingJobs()).toEqual([]);
			expect(await store.activeLeases()).toEqual([]);
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
});
