import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createHeldJobPruner,
	pruneHeldJobs,
	refreshHeldPruneWitnessFromStore,
} from "../src/isolated-worker/held-job-prune.js";
import { createPollIngestCoalesce } from "../src/isolated-worker/poll-ingest-coalesce.js";
import { job, NOW } from "./fixtures.js";

const stores: SqliteCiStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function boxStore() {
	const store = new SqliteCiStore(":memory:");
	stores.push(store);
	await store.configure(
		create(ConfigurationSchema, {
			accounts: [
				create(AccountSchema, {
					id: "customer",
					maxRuntimeMinutes: 30,
					startupMinutes: 5,
					offers: [
						{
							id: "box",
							provider: "hobo-box-worker",
							providerAccountId: "worker",
							backend: "isolated-container",
							enabled: true,
							runsOn: "hobo-isolated-worker",
							concurrency: 2,
							observedAt: NOW,
							validUntil: "2030-01-01T00:00:00Z",
							sourceUrl: "https://example.test/evidence",
							bridgeAcknowledged: true,
							priceMicrosPerMinute: 0,
						},
					],
				}),
			],
			connections: [
				create(ConnectionSchema, {
					accountId: "customer",
					repository: "org/repo",
					repositoryId: 101,
					installationId: 10,
					runnerGroupId: 1,
					isolatedOnly: true,
					acceptAllMatchingRepositoryJobs: true,
					trustedRepositoryAcknowledged: true,
					publicRepositoryAcknowledged: true,
				}),
			],
		}),
		0,
		NOW,
	);
	return store;
}

it("withdraws a pending job when the poll witness shows its run was cancelled", async () => {
	const store = await boxStore();
	const queued = create(JobSchema, {
		...job(42),
		runId: 43107920330,
	});
	await store.queue(queued, NOW, 1);
	const log = vi.fn();
	const pruned = await pruneHeldJobs({
		store,
		at: NOW,
		witness: {
			terminalRuns: [
				{
					repositoryId: 101,
					runId: 43107920330,
					reason: "run-cancelled",
				},
			],
			terminalJobs: [],
		},
		log,
	});
	expect(pruned).toBe(1);
	expect(await store.pendingJobs()).toHaveLength(0);
	expect(log).toHaveBeenCalledWith("hobo_ci_held_job_pruned", {
		jobId: 42,
		runId: 43107920330,
		runAttempt: 1,
		repositoryId: 101,
		reason: "run-cancelled",
	});
});

it("withdraws an unlaunched reservation for a completed job on the witness", async () => {
	const store = await boxStore();
	const state = await store.configuration();
	const account = state?.configuration.accounts[0];
	if (!account) throw new Error("account missing");
	const queued = create(JobSchema, {
		...job(7),
		runId: 43111719541,
		name: "shard",
		isolatedRequired: true,
		memoryClass: "light",
		memoryMb: 1536,
	});
	await store.queue(queued, NOW, 1);
	const lease = await store.reserve(account, queued, NOW);
	expect(lease).toMatchObject({ state: "reserved", runnerId: 0 });
	const log = vi.fn();
	const pruned = await pruneHeldJobs({
		store,
		at: NOW,
		witness: {
			terminalRuns: [],
			terminalJobs: [
				{
					repositoryId: 101,
					jobId: 7,
					runAttempt: 1,
					reason: "job-completed",
				},
			],
		},
		log,
	});
	expect(pruned).toBe(1);
	expect(await store.pendingJobs()).toHaveLength(0);
	expect(await store.activeLeases()).toHaveLength(0);
	expect(log).toHaveBeenCalledWith("hobo_ci_held_job_pruned", {
		jobId: 7,
		runId: 43111719541,
		runAttempt: 1,
		repositoryId: 101,
		reason: "job-completed",
	});
});

it("clears ingest coalesce after a prune", async () => {
	const store = await boxStore();
	const queued = create(JobSchema, {
		...job(99),
		runId: 55,
	});
	await store.queue(queued, NOW, 1);
	const coalesce = createPollIngestCoalesce({ now: () => 0 });
	coalesce.observe(101, 99, 1, "waiting-for-budget-or-capacity");
	expect(coalesce.shouldSkip(101, 99, 1)).toBe(true);
	await pruneHeldJobs({
		store,
		at: NOW,
		coalesce,
		witness: {
			terminalRuns: [{ repositoryId: 101, runId: 55, reason: "run-completed" }],
			terminalJobs: [],
		},
	});
	expect(coalesce.shouldSkip(101, 99, 1)).toBe(false);
});

it("rate-limits admission-time prune passes", async () => {
	const store = await boxStore();
	const pruner = createHeldJobPruner({
		store,
		now: () => 0,
		minIntervalMs: 30_000,
	});
	pruner.observePollWitness({
		terminalRuns: [{ repositoryId: 101, runId: 1, reason: "run-cancelled" }],
		terminalJobs: [],
	});
	expect(await pruner.maybePrune()).toBe(0);
});

it("force prune clears held jobs when witness was seeded at startup", async () => {
	const store = await boxStore();
	const queued = create(JobSchema, {
		...job(12),
		runId: 43107920330,
	});
	await store.queue(queued, NOW, 1);
	const pruner = createHeldJobPruner({ store, now: () => 0 });
	pruner.observePollWitness({
		terminalRuns: [
			{ repositoryId: 101, runId: 43107920330, reason: "run-cancelled" },
		],
		terminalJobs: [],
	});
	expect(await pruner.maybePrune(true)).toBe(1);
	expect(await store.pendingJobs()).toHaveLength(0);
});

it("refreshHeldPruneWitnessFromStore marks completed runs from GitHub", async () => {
	const store = await boxStore();
	const queued = create(JobSchema, {
		...job(88),
		runId: 43111719541,
	});
	await store.queue(queued, NOW, 1);
	const github: GithubTransport = {
		request: async () =>
			new Response(
				JSON.stringify({
					id: 43111719541,
					run_attempt: 1,
					event: "push",
					head_sha: "a".repeat(40),
					head_branch: "main",
					path: ".github/workflows/ci.yml",
					display_title: "push",
					status: "completed",
					conclusion: "cancelled",
					run_started_at: NOW,
					updated_at: NOW,
					actor: { id: 1 },
					repository: { id: 101, private: true },
					head_repository: { id: 101 },
				}),
				{ status: 200 },
			),
	};
	const witness = await refreshHeldPruneWitnessFromStore({ store, github });
	expect(witness.terminalRuns).toEqual([
		{
			repositoryId: 101,
			runId: 43111719541,
			reason: "run-cancelled",
		},
	]);
});
