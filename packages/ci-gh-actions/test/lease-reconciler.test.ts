import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type Configuration,
	ConfigurationSchema,
	ConfigurationStateSchema,
	ConnectionSchema,
	JobSchema,
	type Lease,
	LeaseSchema,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { describe, expect, it, vi } from "vitest";
import { waitForIsolatedWorkerDrain } from "../src/isolated-worker/daemon-shutdown.js";
import {
	createWorkerLeaseReconciler,
	type WorkerLeaseReconciliationStore,
} from "../src/isolated-worker/lease-reconciler.js";
import { createWorkerMemoryAdmission } from "../src/isolated-worker/memory-admission.js";
import { resolveWorkerMemoryConfig } from "../src/isolated-worker/memory-classes.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const configuration: Configuration = create(ConfigurationSchema, {
	accounts: [
		create(AccountSchema, {
			id: "customer",
			maxRuntimeMinutes: 30,
			startupMinutes: 5,
			offers: [
				create(OfferSchema, {
					id: "box",
					provider: "hobo-box-worker",
					providerAccountId: "worker-a",
					backend: "isolated-container",
					enabled: true,
					runsOn: "hobo-isolated-worker",
					concurrency: 3,
					observedAt: "2026-11-01T00:00:00.000Z",
					validUntil: "2026-12-31T23:59:59.000Z",
					sourceUrl: "https://example.test/box-evidence",
					bridgeAcknowledged: true,
				}),
			],
		}),
	],
	connections: [
		create(ConnectionSchema, {
			accountId: "customer",
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

function staleLease(id: string, jobId: number): Lease {
	return create(LeaseSchema, {
		id,
		accountId: "customer",
		offerId: "box",
		provider: "hobo-box-worker",
		jobId,
		originalRunId: 900,
		runAttempt: 1,
		repositoryId: 101,
		repository: "Org/Repo",
		installationId: 10,
		state: "running",
		runnerName: `hobo-${id}`,
		sandboxName: `hobo-${id}`,
		sandboxSessionId: id.replaceAll("-", "").padEnd(64, "0"),
		createdAt: "2026-11-04T11:00:00.000Z",
		memoryClass: "heavy",
		memoryMb: 6_144,
	});
}

function storeWith(leases: Lease[]): WorkerLeaseReconciliationStore {
	const active = leases;
	return {
		activeLeases: async () => active,
		all: async () => active,
		configuration: async () =>
			create(ConfigurationStateSchema, { revision: 1, configuration }),
		get: async (id) => active.find((lease) => lease.id === id),
		abortIsolatedAndRequeue: vi.fn(async (id: string) => {
			const index = active.findIndex((lease) => lease.id === id);
			if (index >= 0) active.splice(index, 1);
		}),
	};
}

describe("worker lease reconciliation", () => {
	it("releases leaked memory when no job containers remain and admits the next job", async () => {
		const active = [
			staleLease("00000000-0000-4000-8000-000000000001", 1),
			staleLease("00000000-0000-4000-8000-000000000002", 2),
		];
		const store = storeWith(active);
		const log = vi.fn();
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => []),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			orphanGraceMs: 1_000,
			now: () => NOW,
			log,
		});
		const admission = createWorkerMemoryAdmission(
			resolveWorkerMemoryConfig(
				{ HOBO_CI_WORKER_MEMORY_BUDGET_MB: "13954" },
				{ totalMemoryMb: 32_768, trunkSlots: 0 },
			),
		);
		const request = {
			jobId: 3,
			memoryClass: "light",
			memoryMb: 3_072,
			rank: 1,
			generalLeaseIds: new Set(active.map((lease) => lease.id)),
		} as const;
		expect(admission.admit({ ...request, activeLeases: active }).admitted).toBe(
			false,
		);

		const result = await reconciler.reconcile();

		expect(active).toEqual([]);
		expect(result.liveLeaseIds.size).toBe(0);
		expect(
			admission.admit({
				...request,
				generalLeaseIds: new Set<string>(),
				activeLeases: active,
			}).admitted,
		).toBe(true);
		expect(log).toHaveBeenCalledTimes(3);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_lease_orphan_released",
			expect.objectContaining({
				leaseId: "00000000-0000-4000-8000-000000000001",
				jobId: 1,
				runId: 900,
				state: "running",
				reason: "container-missing",
				ageMs: 3_600_000,
				memoryMb: 6_144,
			}),
		);
	});

	it("logs the assigned job when releasing an orphan lease", async () => {
		const lease = staleLease("00000000-0000-4000-8000-000000000001", 1);
		lease.actualJobId = 999;
		const store = storeWith([lease]);
		const log = vi.fn();
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => []),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
			log,
		});

		await reconciler.reconcile();

		expect(log).toHaveBeenCalledWith(
			"hobo_ci_lease_orphan_released",
			expect.objectContaining({
				leaseId: lease.id,
				jobId: 999,
				requestedJobId: 1,
			}),
		);
	});

	it("logs the assigned job for a historical lease's orphan container", async () => {
		const lease = staleLease("00000000-0000-4000-8000-000000000099", 1);
		lease.actualJobId = 999;
		lease.state = "cancelled";
		const store = storeWith([]);
		store.all = async () => [lease];
		const log = vi.fn();
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => [
					{
						name: lease.sandboxName,
						containerId: lease.sandboxSessionId,
						state: "exited" as const,
					},
				]),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
			log,
		});

		await reconciler.reconcile();

		expect(log).toHaveBeenCalledWith(
			"hobo_ci_container_orphan_removed",
			expect.objectContaining({
				containerId: lease.sandboxSessionId,
				jobId: 999,
				requestedJobId: 1,
			}),
		);
	});

	it("settles an exited container instead of retaining its lease", async () => {
		const active = [staleLease("00000000-0000-4000-8000-000000000001", 1)];
		const lease = active[0];
		if (!lease) throw new Error("fixture lease");
		const store = storeWith(active);
		const settleExited = vi.fn(async (settled: Lease) => {
			active.splice(
				active.findIndex((entry) => entry.id === settled.id),
				1,
			);
		});
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => [
					{
						name: "hobo-00000000-0000-4000-8000-000000000001",
						containerId: "a".repeat(64),
						state: "exited" as const,
					},
				]),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
			settleExited,
		});

		const result = await reconciler.reconcile();

		expect(settleExited).toHaveBeenCalledWith(lease);
		expect(result.liveLeaseIds.size).toBe(0);
	});

	it("stops and removes a worker container that has no lease", async () => {
		const store = storeWith([]);
		const stop = vi.fn(async () => undefined);
		const remove = vi.fn(async () => undefined);
		const log = vi.fn();
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => [
					{
						name: "hobo-00000000-0000-4000-8000-000000000099",
						containerId: "c".repeat(64),
						state: "running" as const,
					},
				]),
				stop,
				remove,
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
			log,
		});

		await reconciler.reconcile();

		expect(stop).toHaveBeenCalledWith(
			"hobo-00000000-0000-4000-8000-000000000099",
			"c".repeat(64),
		);
		expect(remove).toHaveBeenCalledWith(
			"hobo-00000000-0000-4000-8000-000000000099",
			"c".repeat(64),
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_container_orphan_removed",
			expect.objectContaining({
				containerId: "c".repeat(64),
				name: "hobo-00000000-0000-4000-8000-000000000099",
			}),
		);
	});

	it("keeps a lease whose container is running", async () => {
		const lease = staleLease("00000000-0000-4000-8000-000000000001", 1);
		const active = [lease];
		const store = storeWith(active);
		const remove = vi.fn(async () => undefined);
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => [
					{
						name: lease.sandboxName,
						containerId: lease.sandboxSessionId,
						state: "running" as const,
					},
				]),
				stop: vi.fn(async () => undefined),
				remove,
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
		});

		const result = await reconciler.reconcile();

		expect(active).toEqual([lease]);
		expect(result.liveLeaseIds).toEqual(new Set([lease.id]));
		expect(store.abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("keeps a reservation inside its grace and releases it after the grace", async () => {
		let clock = NOW;
		const lease = staleLease("00000000-0000-4000-8000-000000000001", 1);
		lease.state = "reserved";
		lease.sandboxName = "";
		lease.sandboxSessionId = "";
		lease.createdAt = new Date(NOW - 500).toISOString();
		const active = [lease];
		const store = storeWith(active);
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => []),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			orphanGraceMs: 1_000,
			now: () => clock,
		});

		await reconciler.reconcile();
		expect(active).toEqual([lease]);
		expect(store.abortIsolatedAndRequeue).not.toHaveBeenCalled();

		clock += 501;
		await reconciler.reconcile();
		expect(active).toEqual([]);
		expect(store.abortIsolatedAndRequeue).toHaveBeenCalledTimes(1);
	});

	it("releases nothing when Docker inventory fails", async () => {
		const lease = staleLease("00000000-0000-4000-8000-000000000001", 1);
		const active = [lease];
		const store = storeWith(active);
		const log = vi.fn();
		const remove = vi.fn(async () => undefined);
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => {
					throw new Error("docker ps timed out");
				}),
				stop: vi.fn(async () => undefined),
				remove,
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
			log,
		});

		const result = await reconciler.reconcile({ draining: true });

		expect(result).toEqual({
			inventoryKnown: false,
			liveLeaseIds: new Set([lease.id]),
		});
		expect(active).toEqual([lease]);
		expect(store.abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith("hobo_ci_lease_reconciliation_failed", {
			message: "docker ps timed out",
		});
	});

	it("drains immediately when no lease has a live container", async () => {
		const lease = staleLease("00000000-0000-4000-8000-000000000001", 1);
		lease.state = "reserved";
		lease.sandboxName = "";
		lease.sandboxSessionId = "";
		lease.createdAt = new Date(NOW).toISOString();
		const active = [lease];
		const store = storeWith(active);
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => []),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			orphanGraceMs: 120_000,
			now: () => NOW,
		});
		let liveLeaseIds = new Set([lease.id]);
		const sleep = vi.fn(async () => undefined);
		const result = await waitForIsolatedWorkerDrain({
			inFlight: async () => liveLeaseIds.size,
			reconcile: async () => {
				liveLeaseIds = new Set(
					(await reconciler.reconcile({ draining: true })).liveLeaseIds,
				);
			},
			pollMs: 500,
			timeoutMs: 1_800_000,
			sleep,
			now: () => 0,
		});

		expect(result).toEqual({ drained: true, remaining: 0 });
		expect(active).toEqual([]);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("keeps draining while a lease container is genuinely running", async () => {
		const lease = staleLease("00000000-0000-4000-8000-000000000001", 1);
		const active = [lease];
		const store = storeWith(active);
		const reconciler = createWorkerLeaseReconciler({
			store,
			docker: {
				list: vi.fn(async () => [
					{
						name: lease.sandboxName,
						containerId: lease.sandboxSessionId,
						state: "running" as const,
					},
				]),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => undefined),
			},
			workerAccountId: "worker-a",
			workerMemoryMb: 6_144,
			now: () => NOW,
		});
		let clock = 0;
		const sleep = vi.fn(async (ms: number) => {
			clock += ms;
		});
		const result = await waitForIsolatedWorkerDrain({
			inFlight: async () =>
				(await reconciler.reconcile({ draining: true })).liveLeaseIds.size,
			reconcile: async () => {
				await reconciler.reconcile({ draining: true });
			},
			pollMs: 500,
			timeoutMs: 1_000,
			sleep,
			now: () => clock,
		});

		expect(result).toEqual({ drained: false, remaining: 1 });
		expect(sleep).toHaveBeenCalled();
		expect(active).toEqual([lease]);
	});

	it("recovers a restarted SQLite journal full of stale leases on the first reconciliation", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-ci-lease-restart-"));
		const path = join(root, "worker.sqlite");
		let store = new SqliteCiStore(path);
		let open = true;
		try {
			await store.configure(
				configuration,
				0,
				new Date(NOW - 3_600_000).toISOString(),
			);
			const account = configuration.accounts[0];
			if (!account) throw new Error("fixture account");
			for (const jobId of [1, 2]) {
				const job = create(JobSchema, {
					id: jobId,
					runId: 900,
					runAttempt: 1,
					repositoryId: 101,
					installationId: 10,
					repository: "Org/Repo",
					labels: ["hobo"],
					action: "queued",
					isolatedRequired: true,
					memoryClass: "heavy",
					memoryMb: 6_144,
				});
				const at = new Date(NOW - 3_600_000).toISOString();
				await store.queue(job, at, 1);
				expect(await store.reserve(account, job, at, 1)).toBeDefined();
			}
			expect(await store.activeLeases()).toHaveLength(2);
			store.close();
			open = false;
			store = new SqliteCiStore(path);
			open = true;
			const reconciler = createWorkerLeaseReconciler({
				store,
				docker: {
					list: vi.fn(async () => []),
					stop: vi.fn(async () => undefined),
					remove: vi.fn(async () => undefined),
				},
				workerAccountId: "worker-a",
				workerMemoryMb: 6_144,
				orphanGraceMs: 1_000,
				now: () => NOW,
			});

			const result = await reconciler.reconcile();

			expect(result.inventoryKnown).toBe(true);
			expect(result.liveLeaseIds.size).toBe(0);
			expect(await store.activeLeases()).toEqual([]);
			expect(
				(await store.pendingJobs()).map((job) => job.id).sort((a, b) => a - b),
			).toEqual([1, 2]);
		} finally {
			if (open) store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
