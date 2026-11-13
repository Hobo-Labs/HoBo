import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	type Lease,
	LeaseSchema,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import * as githubModule from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import type { MemoryPeaks } from "../src/isolated-worker/memory-peaks.js";
import type { WorkerStorageFileSystem } from "../src/isolated-worker/storage-admission.js";
import { NOW } from "./fixtures.js";
import { jitRunnerDeregisterGithub } from "./github-deregister-mock.js";

function workDirectory() {
	const retireJobDirectory = vi.fn(async (path: string) => `${path}-retired`);
	const removeJobDirectory = vi.fn(async () => ({ bytes: 128, entries: 4 }));
	const scheduleRetiredSweep = vi.fn();
	const fs: WorkerStorageFileSystem = {
		statfs: vi.fn(async () => ({
			blocks: 100,
			bfree: 100,
			files: 100,
			ffree: 100,
		})),
		device: vi.fn(async () => 1),
		jobDirectories: vi.fn(async () => []),
		retiredDirectories: vi.fn(async () => []),
		prepareJobDirectory: vi.fn(async () => undefined),
		retireJobDirectory,
		removeJobDirectory,
	};
	return { fs, retireJobDirectory, removeJobDirectory, scheduleRetiredSweep };
}

function githubJob(
	id: number,
	status: string,
	runnerName: string | null = null,
) {
	return {
		id,
		run_id: 11,
		status,
		labels: ["hobo"],
		runner_name: runnerName,
		run_attempt: 1,
	};
}

function runningLease(overrides: {
	id?: string;
	jobId?: number;
	actualJobId?: number;
}) {
	return create(LeaseSchema, {
		id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
		accountId: "account-a",
		provider: "kubernetes",
		repository: "org/repo",
		repositoryId: 101,
		installationId: 10,
		jobId: overrides.jobId ?? 100,
		jobName: "PR impact gate",
		memoryClass: "heavy",
		memoryMb: 6_144,
		actualJobId: overrides.actualJobId ?? 0,
		originalRunId: 11,
		runAttempt: 1,
		runnerName: "hobo-00000000-0000-4000-8000-000000000001",
		sandboxName: "hobo-00000000-0000-4000-8000-000000000001",
		sandboxSessionId: "container-1",
		state: "running",
		createdAt: NOW,
	});
}

function transitionFor(lease: Lease) {
	return async (
		_id: string,
		expected: readonly string[],
		update: (entry: Lease) => void,
	) => {
		if (!expected.includes(lease.state)) return undefined;
		update(lease);
		return lease;
	};
}

const fixtureStores = new Set<SqliteCiStore>();
function mockedLeaseStore(lease: Lease) {
	const store = new SqliteCiStore(":memory:");
	fixtureStores.add(store);
	vi.spyOn(store, "get").mockResolvedValue(lease);
	const transition = vi
		.spyOn(store, "transition")
		.mockImplementation(transitionFor(lease));
	const settle = vi.spyOn(store, "settle").mockResolvedValue(lease);
	return { store, transition, settle };
}

function deniedGithub(): GithubTransport {
	return jitRunnerDeregisterGithub();
}

describe("isolated container controller reconcile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const store of fixtureStores) store.close();
		fixtureStores.clear();
	});

	it("does not repeatedly settle an estimated shared-budget liability", async () => {
		const lease = runningLease({});
		lease.state = "uncertain";
		lease.sandboxStage = "stopped";
		lease.budgetId = "shared-budget";
		lease.usageProvenance = "estimated";
		lease.usageCompletedAt = "2026-10-26T12:01:00Z";
		lease.settledAt = "2026-10-26T12:02:00Z";
		const { store, settle } = mockedLeaseStore(lease);
		const github = deniedGithub();
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(),
			list: vi.fn(async () => []),
		};
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:03:00Z",
		});

		await controller.host.reconcile(lease.id, true);
		await controller.host.reconcile(lease.id, true);
		expect(settle).not.toHaveBeenCalled();
		expect(lease.state).toBe("uncertain");
	});

	it("does not stop a dispatched session that is still starting", async () => {
		const lease = runningLease({});
		lease.state = "dispatched";
		const { store, settle } = mockedLeaseStore(lease);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(async () => true),
		};
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
		});

		await controller.host.reconcile(lease.id);
		expect(docker.stop).not.toHaveBeenCalled();
		expect(docker.remove).not.toHaveBeenCalled();
		expect(settle).not.toHaveBeenCalled();
	});

	it.each([
		"uncertain",
		"dispatching",
	] as const)("binds and stops a uniquely observed %s create before settling its lease", async (state) => {
		const lease = runningLease({ jobId: 100 });
		lease.state = state;
		lease.sandboxStage = "creating";
		lease.sandboxSessionId = "";
		const { store, transition, settle } = mockedLeaseStore(lease);
		const stop = vi.fn(async () => undefined);
		const remove = vi.fn(async () => undefined);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop,
			remove,
			isRunning: vi.fn(async () => true),
			list: vi.fn(async () => [
				{
					name: lease.sandboxName,
					containerId: "observed-id",
					state: "running" as const,
				},
			]),
		};
		const github = deniedGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await controller.host.reconcile(lease.id, true);
		expect(transition).toHaveBeenCalledTimes(state === "dispatching" ? 5 : 4);
		expect(lease.sandboxSessionId).toBe("observed-id");
		expect(stop).toHaveBeenCalledWith(lease.sandboxName, "observed-id");
		expect(remove).toHaveBeenCalledWith(lease.sandboxName, "observed-id");
		expect(settle).toHaveBeenCalledOnce();
		expect(settle.mock.calls[0]?.[4]).toBeUndefined();
	});

	it("does not bind an uncertain create when inventory is ambiguous or registration may have started", async () => {
		const lease = runningLease({ jobId: 100 });
		lease.state = "uncertain";
		lease.sandboxStage = "creating";
		lease.sandboxSessionId = "";
		const { store, transition } = mockedLeaseStore(lease);
		const container = {
			name: lease.sandboxName,
			containerId: "observed-id",
			state: "running",
		} as const;
		const list = vi.fn(async () => [container, container]);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(),
			list,
		};
		const github = deniedGithub();
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
		});
		await controller.host.reconcile(lease.id, true);
		expect(transition).not.toHaveBeenCalled();
		lease.sandboxStage = "registering";
		await controller.host.reconcile(lease.id, true);
		expect(list).toHaveBeenCalledTimes(1);
		expect(transition).not.toHaveBeenCalled();
		lease.state = "dispatching";
		lease.sandboxStage = "creating";
		lease.runnerId = 42;
		await controller.host.reconcile(lease.id, true);
		expect(transition).not.toHaveBeenCalled();
		lease.runnerId = 0;
		lease.hostRunId = 42;
		await controller.host.reconcile(lease.id, true);
		expect(transition).not.toHaveBeenCalled();
		lease.hostRunId = 0;
		lease.usageCompletedAt = NOW;
		await controller.host.reconcile(lease.id, true);
		expect(transition).not.toHaveBeenCalled();
	});

	it("retains an interrupted create if its uncertain hold cannot be recorded", async () => {
		const lease = runningLease({});
		lease.state = "dispatching";
		lease.sandboxStage = "creating";
		lease.sandboxSessionId = "";
		const { store, transition } = mockedLeaseStore(lease);
		transition.mockRejectedValue(new Error("budget authority unavailable"));
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(),
			list: vi.fn(async () => []),
		};
		const ctl = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
		});
		await expect(ctl.host.reconcile(lease.id, true)).rejects.toThrow(
			"budget authority unavailable",
		);
		expect(lease.state).toBe("dispatching");
		expect(docker.stop).not.toHaveBeenCalled();
	});

	it("retains the stop time and retries settlement when final job observation fails", async () => {
		const lease = runningLease({ jobId: 100 });
		let clock = "2026-10-26T12:02:00Z";
		const { store, settle } = mockedLeaseStore(lease);
		const stop = vi.fn(async () => undefined);
		const remove = vi.fn(async () => undefined);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop,
			remove,
			isRunning: vi.fn(async () => true),
			list: vi.fn(async () => []),
		};
		const github = deniedGithub();
		vi.spyOn(githubModule, "getJob").mockImplementation(async () => {
			throw new Error("temporary GitHub failure");
		});
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => clock,
		});
		await expect(controller.host.reconcile(lease.id, true)).rejects.toThrow(
			"temporary GitHub failure",
		);
		vi.mocked(githubModule.getJob).mockClear();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		expect(lease.sandboxStage).toBe("stopped");
		expect(lease.usageCompletedAt).toBe(clock);
		expect(settle).not.toHaveBeenCalled();
		clock = "2026-10-26T12:20:00Z";
		await controller.host.reconcile(lease.id, true);
		expect(stop).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
		expect(settle).toHaveBeenCalledWith(
			lease.id,
			0,
			2,
			clock,
			undefined,
			"2026-10-26T12:02:00Z",
		);
	});

	it("preserves the isolated capacity hold across restart until a removed worker is settled", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-ci-stop-recovery-"));
		const path = join(root, "journal.sqlite");
		let store = new SqliteCiStore(path);
		let open = true;
		try {
			const at = "2026-10-26T12:00:00.000Z";
			const configuration = create(ConfigurationSchema, {
				accounts: [
					create(AccountSchema, {
						id: "account-a",
						budgetMicros: 10_000,
						maxRuntimeMinutes: 30,
						startupMinutes: 5,
						offers: [
							create(OfferSchema, {
								id: "box",
								provider: "hobo-box-worker",
								providerAccountId: "worker-a",
								backend: "isolated-container",
								runsOn: "hobo-isolated-worker",
								enabled: true,
								concurrency: 1,
								priceMicrosPerMinute: 0,
								budgetMicros: 0,
								observedAt: "2026-10-26T11:00:00.000Z",
								validUntil: "2026-11-26T12:00:00.000Z",
								sourceUrl: "https://example.test/worker",
								bridgeAcknowledged: true,
							}),
						],
					}),
				],
				connections: [
					create(ConnectionSchema, {
						accountId: "account-a",
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
			await store.configure(configuration, 0, at);
			const account = configuration.accounts[0];
			if (!account) throw new Error("missing fixture account");
			const job = create(JobSchema, {
				id: 100,
				runId: 11,
				runAttempt: 1,
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				action: "queued",
				labels: ["hobo"],
				isolatedRequired: true,
			});
			await store.queue(job, at, 1);
			const reserved = await store.reserve(account, job, at, 1);
			if (!reserved) throw new Error("fixture reservation failed");
			expect(reserved.reservedPaidMicros).toBe(0);
			await store.transition(
				reserved.id,
				["reserved"],
				(lease) => {
					lease.state = "uncertain";
					lease.sandboxStage = "creating";
					lease.sandboxName = `hobo-${lease.id}`;
				},
				"ci.LeaseUncertain",
				at,
			);
			let present = true;
			const docker: DockerDriver = {
				create: vi.fn(),
				start: vi.fn(),
				exec: vi.fn(),
				list: vi.fn(async () =>
					present
						? [
								{
									name: `hobo-${reserved.id}`,
									containerId: "observed-id",
									state: "running" as const,
								},
							]
						: [],
				),
				isRunning: vi.fn(async () => true),
				stop: vi.fn(async () => undefined),
				remove: vi.fn(async () => {
					present = false;
				}),
			};
			const github = deniedGithub();
			vi.spyOn(githubModule, "getJob").mockImplementation(async () => {
				throw new Error("temporary GitHub failure");
			});
			let clock = "2026-10-26T12:02:00.000Z";
			let controller = createIsolatedContainerController({
				store,
				github,
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => clock,
			});
			await expect(
				controller.host.reconcile(reserved.id, true),
			).rejects.toThrow("temporary GitHub failure");
			vi.mocked(githubModule.getJob).mockResolvedValue(
				githubJob(job.id, "queued"),
			);
			const held = await store.get(reserved.id);
			expect(held).toMatchObject({
				state: "uncertain",
				sandboxStage: "stopped",
				reservedPaidMicros: 0,
				usageCompletedAt: "2026-10-26T12:02:00.000Z",
			});
			const next = create(JobSchema, {
				id: 101,
				runId: 11,
				runAttempt: 1,
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				action: "queued",
				labels: ["hobo"],
				isolatedRequired: true,
			});
			await store.queue(next, clock, 1);
			expect(await store.reserve(account, next, clock, 1)).toBeUndefined();
			store.close();
			open = false;
			store = new SqliteCiStore(path);
			open = true;
			clock = "2026-10-26T12:20:00.000Z";
			controller = createIsolatedContainerController({
				store,
				github,
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => clock,
			});
			await controller.reconcileLeases();
			expect(await store.get(reserved.id)).toMatchObject({
				state: "completed",
				billedMinutes: 2,
				paidMicros: 0,
				usageCompletedAt: "2026-10-26T12:02:00.000Z",
			});
			expect(
				(await store.pendingJobs()).map((pending) => pending.id),
			).not.toContain(job.id);
			expect(await store.reserve(account, next, clock, 1)).toBeDefined();
		} finally {
			if (open) store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never settles or removes work when a forced stop cannot be confirmed", async () => {
		const lease = runningLease({ jobId: 100 });
		const { store, settle } = mockedLeaseStore(lease);
		const work = workDirectory();
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => {
				throw new Error("stop timed out");
			}),
			remove: vi.fn(),
			isRunning: vi.fn(async () => true),
		};
		const github = deniedGithub();
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			workRoot: "/tmp/hobo-ci-test",
			workFs: work.fs,
			scheduleRetiredSweep: work.scheduleRetiredSweep,
		});
		await expect(controller.host.reconcile(lease.id, true)).rejects.toThrow(
			"container stop uncertain",
		);
		expect(lease.sandboxStage).toBe("stopping");
		expect(docker.remove).not.toHaveBeenCalled();
		expect(settle).not.toHaveBeenCalled();
		expect(work.retireJobDirectory).not.toHaveBeenCalled();
	});

	it("settles an auto-removed container only after confirming its absence", async () => {
		const lease = runningLease({ jobId: 100 });
		let present = true;
		const { store, settle } = mockedLeaseStore(lease);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			isRunning: vi.fn(async () => true),
			stop: vi.fn(async () => {
				present = false;
			}),
			remove: vi.fn(async () => {
				throw new Error("no such container");
			}),
			list: vi.fn(async () =>
				present
					? [
							{
								name: lease.sandboxName,
								containerId: lease.sandboxSessionId,
								state: "running" as const,
							},
						]
					: [],
			),
		};
		const github = deniedGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await controller.host.reconcile(lease.id, true);
		expect(docker.list).toHaveBeenCalled();
		expect(lease.sandboxStage).toBe("stopped");
		expect(settle).toHaveBeenCalledOnce();
	});

	it("recovers a lost stop acknowledgement after the container auto-removes", async () => {
		const lease = runningLease({ jobId: 100 });
		let present = true;
		const { store, settle } = mockedLeaseStore(lease);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			isRunning: vi.fn(async () => true),
			stop: vi.fn(async () => {
				present = false;
				throw new Error("ack lost");
			}),
			remove: vi.fn(),
			list: vi.fn(async () =>
				present
					? [
							{
								name: lease.sandboxName,
								containerId: lease.sandboxSessionId,
								state: "running" as const,
							},
						]
					: [],
			),
		};
		const github = deniedGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		const controller = createIsolatedContainerController({
			store,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await expect(controller.host.reconcile(lease.id, true)).rejects.toThrow(
			"container stop uncertain",
		);
		expect(lease.sandboxStage).toBe("stopping");
		expect(settle).not.toHaveBeenCalled();
		await controller.host.reconcile(lease.id, true);
		expect(lease.sandboxStage).toBe("stopped");
		expect(settle).toHaveBeenCalledOnce();
	});

	it("requeues uncertain leases without a container session after the recovery timeout", async () => {
		const stuck = create(LeaseSchema, {
			id: "00000000-0000-4000-8000-000000000001",
			accountId: "account-a",
			provider: "kubernetes",
			repository: "org/repo",
			repositoryId: 101,
			installationId: 10,
			jobId: 1,
			originalRunId: 11,
			runAttempt: 1,
			runnerName: "hobo-00000000-0000-4000-8000-000000000001",
			state: "uncertain",
			createdAt: NOW,
		});
		const abort = vi.fn(async () => {});
		// SAFETY: reconcile() only calls get() and abortIsolatedAndRequeue(); this stub implements both.
		const relayStore = {
			get: async (id: string) => (id === stuck.id ? stuck : undefined),
			abortIsolatedAndRequeue: abort,
		} as SqliteCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(),
		};
		// SAFETY: reconcile() does not call github in this scenario.
		const github = jitRunnerDeregisterGithub();
		const early = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			uncertainWithoutContainerRecoveryMs: 60_000,
			now: () => "2026-10-26T12:00:30Z",
		});
		await early.host.reconcile(stuck.id, true);
		expect(abort).not.toHaveBeenCalled();
		const late = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			uncertainWithoutContainerRecoveryMs: 60_000,
			now: () => "2026-10-26T12:01:01Z",
		});
		await late.host.reconcile(stuck.id, true);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(abort.mock.calls[0]?.[1]).toMatchObject({
			labels: ["hobo"],
			isolatedRequired: true,
		});
	});

	it("force-stop settle does not requeue when the reserved job already completed", async () => {
		const lease = runningLease({ actualJobId: 100 });
		const settle = vi.fn(async () => lease);
		// SAFETY: force-stop reconcile uses get(), transition(), and settle(); this stub implements those methods.
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			transition: transitionFor(lease),
			settle,
		} as SqliteCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
		};
		// SAFETY: force-stop reconcile uses getJob(), not github.request().
		const github = jitRunnerDeregisterGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "completed", lease.runnerName),
		);
		const controller = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await controller.host.reconcile(lease.id, true);
		expect(settle).toHaveBeenCalledTimes(1);
		expect(settle.mock.calls[0]?.[4]).toBeUndefined();
	});

	it("force-stop settle requeues when GitHub assigned a different job to the runner", async () => {
		const lease = runningLease({ jobId: 100, actualJobId: 999 });
		const settle = vi.fn(async () => lease);
		const withdrawQueuedJob = vi.fn(async () => true);
		// SAFETY: force-stop reconcile uses get(), transition(), settle(); this stub implements those methods.
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob,
		} as SqliteCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
		};
		// SAFETY: force-stop reconcile uses getJob(), not github.request().
		const github = jitRunnerDeregisterGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		const controller = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await controller.host.reconcile(lease.id, true);
		expect(settle).toHaveBeenCalledTimes(1);
		expect(settle.mock.calls[0]?.[4]).toBeUndefined();
		expect(withdrawQueuedJob).toHaveBeenCalledOnce();
	});

	it("force-stop settle withdraws when the reserved job is still queued and unassigned", async () => {
		const lease = runningLease({ jobId: 100, actualJobId: 0 });
		const settle = vi.fn(async () => lease);
		const withdrawQueuedJob = vi.fn(async () => true);
		// SAFETY: force-stop reconcile uses get(), transition(), settle(); this stub implements those methods.
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob,
		} as SqliteCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
		};
		// SAFETY: force-stop reconcile uses getJob(), not github.request().
		const github = jitRunnerDeregisterGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		const controller = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await controller.host.reconcile(lease.id, true);
		expect(settle).toHaveBeenCalledTimes(1);
		expect(settle.mock.calls[0]?.[4]).toBeUndefined();
		expect(withdrawQueuedJob).toHaveBeenCalledOnce();
	});

	it("does not abort a running lease when docker inspect fails", async () => {
		const lease = runningLease({ jobId: 100, actualJobId: 0 });
		const abortIsolatedAndRequeue = vi.fn(async () => undefined);
		// SAFETY: non-forced reconcile only calls get() and abortIsolatedAndRequeue().
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			abortIsolatedAndRequeue,
		} as SqliteCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => {
				throw new Error("inspect timed out");
			}),
		};
		// SAFETY: non-forced reconcile never touches GitHub.
		const github = jitRunnerDeregisterGithub();
		const controller = createIsolatedContainerController({
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
		});
		await controller.host.reconcile(lease.id);
		expect(abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(docker.stop).not.toHaveBeenCalled();
		await expect(controller.host.reconcile(lease.id, true)).rejects.toThrow(
			"container status uncertain",
		);
		expect(docker.remove).not.toHaveBeenCalled();
	});

	function markerScenario(
		exists: DockerDriver["exists"],
		stopped = false,
		log?: ReturnType<typeof vi.fn>,
		workRoot?: string,
		memory?: { peak: DockerDriver["memoryPeak"]; peaks: MemoryPeaks },
	) {
		const lease = runningLease({ jobId: 100, actualJobId: 0 });
		const settle = vi.fn(async () => lease);
		const abortIsolatedAndRequeue = vi.fn(async () => undefined);
		const work = workRoot ? workDirectory() : undefined;
		// SAFETY: reconcile() uses get(), transition(), settle(), and abortIsolatedAndRequeue().
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			transition: transitionFor(lease),
			settle,
			abortIsolatedAndRequeue,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => !stopped),
			exists,
			exitState: vi.fn(async () => ({ exitCode: 137, oomKilled: true })),
		};
		if (memory?.peak) docker.memoryPeak = memory.peak;
		// SAFETY: settle after a stop uses the mocked getJob() seam.
		const github = jitRunnerDeregisterGithub();
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(lease.jobId, "queued"),
		);
		const controllerOptions: Parameters<
			typeof createIsolatedContainerController
		>[0] = {
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
			log,
		};
		if (memory) {
			controllerOptions.memoryClasses = {
				light: 3_072,
				standard: 4_096,
				heavy: 6_144,
			};
			controllerOptions.memoryPeaks = memory.peaks;
		}
		if (workRoot && work)
			Object.assign(controllerOptions, {
				workRoot,
				workFs: work.fs,
				scheduleRetiredSweep: work.scheduleRetiredSweep,
			});
		const controller = createIsolatedContainerController(controllerOptions);
		return {
			lease,
			settle,
			abortIsolatedAndRequeue,
			docker,
			controller,
			work,
			store: relayStore,
		};
	}

	it("logs the job memory class when docker reports an exit-137 OOM kill", async () => {
		const log = vi.fn();
		const s = markerScenario(undefined, true, log);
		s.lease.memoryClass = "light";
		s.lease.memoryMb = 3_072;
		await s.controller.host.reconcile(s.lease.id);
		expect(s.docker.exitState).toHaveBeenCalledWith(
			s.lease.sandboxName,
			s.lease.sandboxSessionId,
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_container_oom",
			expect.objectContaining({
				jobId: s.lease.jobId,
				memoryClass: "light",
				memoryMb: 3_072,
				exitCode: 137,
			}),
		);
	});

	it("records and logs a running container's peak before stopping it", async () => {
		const order: string[] = [];
		const record = vi.fn();
		const peaks: MemoryPeaks = {
			history: {},
			record,
			recordOom: vi.fn(),
		};
		const log = vi.fn();
		const peak = vi.fn(async () => {
			order.push("peak");
			return 2_049;
		});
		const s = markerScenario(
			vi.fn(async () => true),
			false,
			log,
			undefined,
			{
				peak,
				peaks,
			},
		);
		s.lease.memoryMb = 1_536;
		s.docker.stop = vi.fn(async () => {
			order.push("stop");
		});
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "completed", s.lease.runnerName),
		);

		await s.controller.host.reconcile(s.lease.id);

		expect(order).toEqual(["peak", "stop"]);
		expect(record).toHaveBeenCalledWith("PR impact gate", 2_049);
		expect(log).toHaveBeenCalledWith("hobo_ci_container_memory_peak", {
			jobId: s.lease.jobId,
			jobName: "PR impact gate",
			memoryClass: "heavy",
			limitMb: 6_144,
			reservedMb: 1_536,
			peakMb: 2_049,
		});
		expect(s.settle).toHaveBeenCalledOnce();
	});

	it("settles when peak measurement fails", async () => {
		const peaks: MemoryPeaks = {
			history: {},
			record: vi.fn(),
			recordOom: vi.fn(),
		};
		const s = markerScenario(
			vi.fn(async () => true),
			false,
			undefined,
			undefined,
			{
				peak: vi.fn(async () => {
					throw new Error("cgroup unavailable");
				}),
				peaks,
			},
		);
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "completed", s.lease.runnerName),
		);

		await s.controller.host.reconcile(s.lease.id);

		expect(s.docker.stop).toHaveBeenCalledOnce();
		expect(s.settle).toHaveBeenCalledOnce();
		expect(peaks.record).not.toHaveBeenCalled();
	});

	it("resets learned history when docker reports an OOM kill", async () => {
		const peaks: MemoryPeaks = {
			history: {},
			record: vi.fn(),
			recordOom: vi.fn(),
		};
		const peak = vi.fn(async () => 2_049);
		const s = markerScenario(undefined, true, undefined, undefined, {
			peak,
			peaks,
		});

		await s.controller.host.reconcile(s.lease.id);

		expect(peaks.recordOom).toHaveBeenCalledWith("PR impact gate");
		expect(peak).not.toHaveBeenCalled();
	});

	it("stops and settles a running lease once its runner wrote the exit marker", async () => {
		const exists = vi.fn(async () => true);
		const log = vi.fn();
		const s = markerScenario(exists, false, log);
		s.lease.runnerId = 42;
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "completed", s.lease.runnerName),
		);
		await s.controller.host.reconcile(s.lease.id);
		expect(exists).toHaveBeenCalledWith(
			s.lease.sandboxName,
			s.lease.sandboxSessionId,
			"/tmp/hobo-ci-runner-exited",
		);
		expect(s.docker.stop).toHaveBeenCalledTimes(1);
		expect(s.docker.remove).toHaveBeenCalledTimes(1);
		expect(s.settle).toHaveBeenCalledTimes(1);
		expect(s.settle.mock.calls[0]?.[4]).toBeUndefined();
		expect(s.abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalledWith(
			"hobo_ci_orphan_job_detected",
			expect.anything(),
		);
	});

	it("withdraws local demand when the runner exited without taking the job", async () => {
		const s = markerScenario(vi.fn(async () => true));
		const withdrawQueuedJob = vi.fn(async () => true);
		// SAFETY: optional withdraw hook on the HostedRelay store surface.
		s.store.withdrawQueuedJob = withdrawQueuedJob;
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "queued"),
		);
		await s.controller.host.reconcile(s.lease.id);
		expect(s.settle.mock.calls[0]?.[4]).toBeUndefined();
		expect(withdrawQueuedJob).toHaveBeenCalledOnce();
	});

	it.each([
		"pass",
		"fail",
	])("retires and schedules the work directory after a job %s", async () => {
		const s = markerScenario(
			vi.fn(async () => true),
			false,
			undefined,
			"/srv/hobo-ci/work",
		);
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "completed", s.lease.runnerName),
		);
		await s.controller.host.reconcile(s.lease.id);
		expect(s.work?.retireJobDirectory).toHaveBeenCalledWith(
			`/srv/hobo-ci/work/${s.lease.sandboxName}`,
		);
		expect(s.work?.scheduleRetiredSweep).toHaveBeenCalledOnce();
		expect(s.work?.removeJobDirectory).not.toHaveBeenCalled();
	});

	it("does not await background removal when reconciling a finished lease", async () => {
		const s = markerScenario(
			vi.fn(async () => true),
			false,
			undefined,
			"/srv/hobo-ci/work",
		);
		if (!s.work) throw new Error("missing work directory fixture");
		s.work.removeJobDirectory.mockImplementation(
			() => new Promise<{ bytes: number; entries: number }>(() => {}),
		);
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "completed", s.lease.runnerName),
		);

		await s.controller.host.reconcile(s.lease.id);
		expect(s.work.retireJobDirectory).toHaveBeenCalledOnce();
		expect(s.work.scheduleRetiredSweep).toHaveBeenCalledOnce();
		expect(s.work.removeJobDirectory).not.toHaveBeenCalled();
	});

	it("retires the work directory after cancellation", async () => {
		const s = markerScenario(undefined, false, undefined, "/srv/hobo-ci/work");
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "completed", s.lease.runnerName),
		);
		await s.controller.host.reconcile(s.lease.id, true);
		expect(s.work?.retireJobDirectory).toHaveBeenCalledWith(
			`/srv/hobo-ci/work/${s.lease.sandboxName}`,
		);
	});

	it("retires the work directory after a container crash", async () => {
		const s = markerScenario(undefined, true, undefined, "/srv/hobo-ci/work");
		await s.controller.host.reconcile(s.lease.id);
		expect(s.abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(s.settle).toHaveBeenCalledWith(
			s.lease.id,
			0,
			2,
			expect.any(String),
			undefined,
			expect.any(String),
		);
		expect(s.work?.retireJobDirectory).toHaveBeenCalledWith(
			`/srv/hobo-ci/work/${s.lease.sandboxName}`,
		);
	});

	it("detects a GitHub orphan when a registered runner's container crashes", async () => {
		const log = vi.fn();
		const s = markerScenario(undefined, true, log);
		s.lease.runnerId = 42;

		await s.controller.host.reconcile(s.lease.id);

		expect(s.abortIsolatedAndRequeue).not.toHaveBeenCalled();
		expect(s.settle).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("hobo_ci_orphan_job_detected", {
			repository: s.lease.repository,
			runId: s.lease.originalRunId,
			jobId: s.lease.jobId,
			runnerId: 42,
			runnerName: s.lease.runnerName,
		});
	});

	it("leaves a running lease and its work directory alone while the runner has not exited or the check fails", async () => {
		for (const exists of [
			vi.fn(async () => false),
			vi.fn(async () => {
				throw new Error("docker exec timed out");
			}),
		]) {
			const s = markerScenario(exists, false, undefined, "/srv/hobo-ci/work");
			await s.controller.host.reconcile(s.lease.id);
			expect(s.docker.stop).not.toHaveBeenCalled();
			expect(s.settle).not.toHaveBeenCalled();
			expect(s.abortIsolatedAndRequeue).not.toHaveBeenCalled();
			expect(s.work?.retireJobDirectory).not.toHaveBeenCalled();
			expect(s.work?.scheduleRetiredSweep).not.toHaveBeenCalled();
			expect(s.work?.removeJobDirectory).not.toHaveBeenCalled();
		}
	});
});
