import { create } from "@bufbuild/protobuf";
import { AccountSchema, ConfigurationSchema, ConnectionSchema } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { HostedRelay } from "../src/hosted-relay.js";
import { createWorkerLeaseReconciler } from "../src/isolated-worker/lease-reconciler.js";
import { job, NOW, queued, run, SECRET } from "./fixtures.js";

const stores: SqliteCiStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	vi.restoreAllMocks();
});

async function isolatedRelay(github: GithubTransport) {
	const store = new SqliteCiStore(":memory:");
	stores.push(store);
	const configuration = create(ConfigurationSchema, {
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
	});
	await store.configure(configuration, 0, NOW);
	const reconcile = vi.fn(async () => undefined);
	const relay = new HostedRelay({
		config: configuration,
		store,
		github,
		identity: {
			async verify() {
				throw new Error("unexpected");
			},
		},
		webhookSecret: SECRET,
		isolatedHost: { launch: vi.fn(), reconcile },
		now: () => NOW,
	});
	return { store, relay, reconcile, configuration };
}

describe("foreign yield vs live box custody", () => {
	it("does not yield when the box JIT runner is already in_progress on that job", async () => {
		const servedRunId = 22;
		const github = {
			request: async (_installation: number, path: string) => {
				if (path === "/repos/org/repo/actions/runs/11")
					return Response.json(run());
				if (path === "/repos/org/repo/actions/jobs/1")
					return Response.json({
						id: 1,
						run_id: 11,
						run_attempt: 1,
						status: "in_progress",
						labels: ["hobo"],
						runner_name: "hobo-runner-arc",
					});
				if (path.startsWith("/repos/org/repo/actions/runs?status=in_progress"))
					return Response.json({ workflow_runs: [{ id: servedRunId }] });
				if (
					path ===
					`/repos/org/repo/actions/runs/${servedRunId}/jobs?filter=latest&per_page=100`
				)
					return Response.json({
						jobs: [
							{
								id: 1,
								run_id: servedRunId,
								status: "in_progress",
								runner_name: runner,
								runner_id: 9,
							},
						],
					});
				if (
					path ===
					"/repos/org/repo/actions/runs/11/jobs?filter=latest&per_page=100"
				)
					return Response.json({
						jobs: [
							{
								id: 1,
								run_id: 11,
								run_attempt: 1,
								status: "in_progress",
								runner_name: "hobo-runner-arc",
							},
						],
					});
				throw new Error(`unexpected: ${path}`);
			},
		} satisfies GithubTransport;
		const { store, relay, reconcile } = await isolatedRelay(github);
		const account = (await store.configuration())?.configuration?.accounts[0];
		if (!account) throw new Error("fixture account");
		const demand = job();
		await store.queue(demand, NOW, 1);
		const lease = await store.reserve(account, demand, NOW, 1);
		if (!lease) throw new Error("fixture lease");
		const runner = `hobo-${lease.id}`;
		await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "running";
				entry.runnerName = runner;
				entry.runnerId = 9;
				entry.sandboxName = runner;
				entry.sandboxSessionId = "cid";
			},
			"ci.JobStarted",
			NOW,
			1,
		);
		const body = queued();
		body.workflow_job.runner_name = "hobo-runner-arc";
		body.workflow_job.status = "in_progress";
		const result = await relay.processWebhook(
			Buffer.from(JSON.stringify(body)),
			"workflow_job",
		);
		expect(result).toBe("foreign-runner");
		expect(reconcile).not.toHaveBeenCalled();
		expect(await store.activeLeases()).toHaveLength(1);
	});
});

describe("orphan sweep during live GitHub job", () => {
	it("skips removal in progress and honors container custody", async () => {
		const NOW_MS = 1_762_848_000_000;
		const runner = "hobo-00000000-0000-4000-8000-000000000099";
		const remove = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("removal of container cid is already in progress"),
			)
			.mockResolvedValue(undefined);
		const stop = vi.fn(async () => undefined);
		const custody = vi.fn(async () => false);
		const reconciler = createWorkerLeaseReconciler({
			store: {
				activeLeases: async () => [],
				configuration: async () => undefined,
				get: async () => undefined,
				abortIsolatedAndRequeue: vi.fn(),
			},
			docker: {
				list: vi.fn(async () => [
					{
						name: runner,
						containerId: "cid",
						state: "running" as const,
						createdAtMs: NOW_MS - 3 * 60_000,
					},
				]),
				stop,
				remove,
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW_MS,
			containerCustody: custody,
		});
		await reconciler.reconcile();
		await reconciler.reconcile();
		expect(custody).toHaveBeenCalled();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
	});

	it("does not remove a removing-state container", async () => {
		const remove = vi.fn(async () => undefined);
		const reconciler = createWorkerLeaseReconciler({
			store: {
				activeLeases: async () => [],
				configuration: async () => undefined,
				get: async () => undefined,
				abortIsolatedAndRequeue: vi.fn(),
			},
			docker: {
				list: vi.fn(async () => [
					{
						name: "hobo-00000000-0000-4000-8000-000000000099",
						containerId: "cid",
						state: "removing" as const,
						createdAtMs: 1,
					},
				]),
				remove,
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => 1_762_848_000_000,
		});
		await reconciler.reconcile();
		expect(remove).not.toHaveBeenCalled();
	});
});
