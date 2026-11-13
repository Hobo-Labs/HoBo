import { create } from "@bufbuild/protobuf";
import { type Lease, LeaseSchema } from "@hobo/ci";
import type { SqliteCiStore } from "@hobo/ci/sqlite";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import * as githubModule from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import {
	createIsolatedContainerController,
	RUNNER_EXITED_PATH,
} from "../src/isolated-worker/container-controller.js";
import { ISOLATED_JIT_QUEUED_BOUND_GRACE_MS } from "../src/isolated-worker/container-timeout.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import { orphanJobCandidateForLease } from "../src/isolated-worker/orphan-jobs.js";
import * as correlationModule from "../src/jit-runner-correlation.js";

function transitionFor(lease: Lease) {
	return vi.fn(
		async (
			id: string,
			_from: string[],
			mutate: (entry: Lease) => void,
			_event: string,
			_at: string,
		) => {
			if (id !== lease.id) return undefined;
			mutate(lease);
			return lease;
		},
	);
}

const RELEASE_RUN = 43275965551;
const MAIN_RUN = 43302513633;
const GHCR_JOB = 131490897930;
const SHARD_JOB = 131490555668;

describe("shared hobo label JIT reassignment", () => {
	it("keeps the runner while GitHub assigned a different hobo job on another run", async () => {
		const leaseId = "237f4d7d-0700-466a-9140-8cbc4d241cc7";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: 0,
			originalRunId: RELEASE_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-release",
			sandboxStage: "running",
			state: "running",
			createdAt: "2026-11-12T12:00:00.000Z",
		});
		const withdrawQueuedJob = vi.fn(async () => true);
		// SAFETY: reconcile touches only get, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle: vi.fn(),
			withdrawQueuedJob,
		} as SqliteCiStore & HostedRelayStore;
		const releaseRunJobs = [
			{
				id: GHCR_JOB,
				run_id: RELEASE_RUN,
				status: "queued",
				runner_name: null,
				runner_id: null,
			},
		];
		const mainRunJobs = [
			{
				id: SHARD_JOB,
				run_id: MAIN_RUN,
				status: "in_progress",
				runner_name: lease.runnerName,
				runner_id: lease.runnerId,
			},
		];
		vi.spyOn(githubModule, "getJob").mockImplementation(
			async (_api, _i, _r, jobId) => {
				if (jobId === GHCR_JOB)
					return {
						id: jobId,
						run_id: RELEASE_RUN,
						status: "queued",
						labels: ["hobo"],
						runner_name: null,
						run_attempt: 1,
					};
				return {
					id: jobId,
					run_id: MAIN_RUN,
					status: "in_progress",
					labels: ["hobo"],
					runner_name: lease.runnerName,
					run_attempt: 1,
				};
			},
		);
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockImplementation(
			async (_api, _i, _r, runId) => {
				if (runId === RELEASE_RUN) return releaseRunJobs;
				if (runId === MAIN_RUN) return mainRunJobs;
				return [];
			},
		);
		vi.spyOn(githubModule, "listInProgressWorkflowRunIds").mockResolvedValue([
			MAIN_RUN,
		]);
		const stop = vi.fn(async () => undefined);
		const remove = vi.fn(async () => undefined);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop,
			remove,
			isRunning: vi.fn(async () => true),
			exists: vi.fn(async () => false),
		};
		const onStorageGrantRelease = vi.fn();
		const log = vi.fn();
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			onStorageGrantRelease,
			now: () => "2026-11-12T12:05:00.000Z",
			log,
		});
		await controller.host.reconcile(lease.id, true);
		expect(stop).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(lease.actualJobId).toBe(SHARD_JOB);
		expect(lease.originalRunId).toBe(MAIN_RUN);
		expect(withdrawQueuedJob).toHaveBeenCalledOnce();
		expect(onStorageGrantRelease).toHaveBeenCalledWith(GHCR_JOB);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_jit_runner_custody_transferred",
			expect.objectContaining({
				servedJobId: SHARD_JOB,
				servedRunId: MAIN_RUN,
			}),
		);
		vi.restoreAllMocks();
	});

	it("defers settle while the cross job runs, then deregisters and settles when it completes", async () => {
		const leaseId = "237f4d7d-0700-466a-9140-8cbc4d241cc7";
		let shardStatus = "in_progress";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: SHARD_JOB,
			originalRunId: MAIN_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-release",
			sandboxStage: "running",
			state: "running",
			usageCompletedAt: "2026-11-12T12:18:00.000Z",
			createdAt: "2026-11-12T12:00:00.000Z",
		});
		const settle = vi.fn();
		// SAFETY: reconcile touches only get, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(githubModule, "getJob").mockImplementation(
			async (_api, _i, _r, jobId) => {
				if (jobId === GHCR_JOB)
					return {
						id: jobId,
						run_id: RELEASE_RUN,
						status: "queued",
						labels: ["hobo"],
						runner_name: null,
						run_attempt: 1,
					};
				return {
					id: jobId,
					run_id: MAIN_RUN,
					status: shardStatus,
					labels: ["hobo"],
					runner_name: lease.runnerName,
					runner_id: null,
					run_attempt: 1,
				};
			},
		);
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockImplementation(
			async (_api, _i, _r, runId) => {
				if (runId === MAIN_RUN)
					return [
						{
							id: SHARD_JOB,
							run_id: MAIN_RUN,
							status: shardStatus,
							runner_name: lease.runnerName,
							runner_id: lease.runnerId,
						},
					];
				return [
					{
						id: GHCR_JOB,
						run_id: RELEASE_RUN,
						status: "queued",
						runner_name: null,
						runner_id: null,
					},
				];
			},
		);
		vi.spyOn(githubModule, "listInProgressWorkflowRunIds").mockImplementation(
			async () => (shardStatus === "in_progress" ? [MAIN_RUN] : []),
		);
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockImplementation(
			async () => ({
				jobId: SHARD_JOB,
				runId: MAIN_RUN,
				status: shardStatus,
			}),
		);
		const remove = vi.fn(async () => undefined);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove,
			list: vi.fn(async () => [
				{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
			]),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async () => false),
		};
		const onStorageGrantRelease = vi.fn();
		const log = vi.fn();
		const controller = createIsolatedContainerController({
			store,
			github: githubAllowRunnerDeregister(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			onStorageGrantRelease,
			now: () => "2026-11-12T12:19:00.000Z",
			log,
		});
		await controller.host.reconcile(lease.id);
		expect(settle).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalledWith(
			"hobo_ci_jit_runner_deregistered",
			expect.anything(),
		);

		shardStatus = "completed";
		vi.mocked(docker.exists).mockImplementation(
			async (_n, _id, path) => path === RUNNER_EXITED_PATH,
		);
		await controller.host.reconcile(lease.id);
		expect(remove).toHaveBeenCalled();
		expect(settle).toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_jit_runner_deregistered",
			expect.objectContaining({ leaseId, runnerId: 99 }),
		);
		expect(onStorageGrantRelease).toHaveBeenCalledWith(GHCR_JOB);
		expect(onStorageGrantRelease).toHaveBeenCalledWith(SHARD_JOB);
		vi.restoreAllMocks();
	});

	it("lets the cross-assigned job finish then settles without killing an active job", async () => {
		const leaseId = "237f4d7d-0700-466a-9140-8cbc4d241cc7";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: SHARD_JOB,
			originalRunId: MAIN_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-release",
			sandboxStage: "running",
			state: "running",
			createdAt: "2026-11-12T12:00:00.000Z",
		});
		const settle = vi.fn();
		// SAFETY: reconcile touches only get, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(githubModule, "getJob").mockImplementation(
			async (_api, _i, _r, jobId) => {
				if (jobId === GHCR_JOB)
					return {
						id: jobId,
						run_id: RELEASE_RUN,
						status: "queued",
						labels: ["hobo"],
						runner_name: null,
						run_attempt: 1,
					};
				return {
					id: jobId,
					run_id: MAIN_RUN,
					status: "completed",
					labels: ["hobo"],
					runner_name: lease.runnerName,
					run_attempt: 1,
				};
			},
		);
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockImplementation(
			async (_api, _i, _r, runId) => {
				if (runId === MAIN_RUN)
					return [
						{
							id: SHARD_JOB,
							run_id: MAIN_RUN,
							status: "completed",
							runner_name: lease.runnerName,
							runner_id: lease.runnerId,
						},
					];
				return [
					{
						id: GHCR_JOB,
						run_id: RELEASE_RUN,
						status: "queued",
						runner_name: null,
						runner_id: null,
					},
				];
			},
		);
		vi.spyOn(githubModule, "listInProgressWorkflowRunIds").mockResolvedValue(
			[],
		);
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: SHARD_JOB,
			runId: MAIN_RUN,
			status: "completed",
		});
		const stop = vi.fn(async () => undefined);
		const remove = vi.fn(async () => undefined);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop,
			remove,
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async (_n, _id, path) => path === RUNNER_EXITED_PATH),
		};
		const controller = createIsolatedContainerController({
			store,
			github: githubAllowRunnerDeregister(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-11-12T12:20:00.000Z",
		});
		await controller.host.reconcile(lease.id);
		expect(remove).toHaveBeenCalled();
		expect(settle).toHaveBeenCalled();
	});

	it("defers stop while a queued-bound job is inside the grace window", async () => {
		const leaseId = "queued-bound-inside-grace";
		const now = "2026-11-12T12:03:00.000Z";
		const createdAt = new Date(
			Date.parse(now) - (ISOLATED_JIT_QUEUED_BOUND_GRACE_MS - 30_000),
		).toISOString();
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: GHCR_JOB,
			originalRunId: RELEASE_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-queued",
			sandboxStage: "running",
			state: "running",
			usageCompletedAt: "2026-11-12T12:02:30.000Z",
			createdAt,
		});
		const settle = vi.fn();
		// SAFETY: reconcile touches only get, activeLeases, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: GHCR_JOB,
			runId: RELEASE_RUN,
			status: "queued",
		});
		vi.spyOn(githubModule, "getJob").mockResolvedValue({
			id: GHCR_JOB,
			run_id: RELEASE_RUN,
			status: "queued",
			labels: ["hobo"],
			runner_name: lease.runnerName,
			runner_id: lease.runnerId,
			run_attempt: 1,
		});
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			list: vi.fn(async () => [
				{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
			]),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async () => false),
		};
		const controller = createIsolatedContainerController({
			store,
			github: githubAllowRunnerDeregister(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => now,
		});
		await controller.host.reconcile(lease.id);
		expect(settle).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("releases a queued-bound job after the grace window", async () => {
		const leaseId = "queued-bound-after-grace";
		const now = "2026-11-12T12:10:00.000Z";
		const createdAt = new Date(
			Date.parse(now) - (ISOLATED_JIT_QUEUED_BOUND_GRACE_MS + 60_000),
		).toISOString();
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: GHCR_JOB,
			originalRunId: RELEASE_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-queued-old",
			sandboxStage: "running",
			state: "running",
			usageCompletedAt: "2026-11-12T12:09:00.000Z",
			createdAt,
		});
		const settle = vi.fn();
		const remove = vi.fn();
		// SAFETY: reconcile touches only get, activeLeases, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: GHCR_JOB,
			runId: RELEASE_RUN,
			status: "queued",
		});
		vi.spyOn(githubModule, "getJob").mockResolvedValue({
			id: GHCR_JOB,
			run_id: RELEASE_RUN,
			status: "queued",
			labels: ["hobo"],
			runner_name: lease.runnerName,
			runner_id: lease.runnerId,
			run_attempt: 1,
		});
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove,
			list: vi.fn(async () => [
				{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
			]),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async () => false),
		};
		const controller = createIsolatedContainerController({
			store,
			github: githubAllowRunnerDeregister(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => now,
		});
		await controller.host.reconcile(lease.id);
		expect(remove).toHaveBeenCalled();
		expect(settle).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("fails closed when correlation and getJob both error", async () => {
		const leaseId = "correlation-and-getjob-fail";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: GHCR_JOB,
			originalRunId: RELEASE_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-fail",
			sandboxStage: "running",
			state: "running",
			usageCompletedAt: "2026-11-12T12:02:00.000Z",
			createdAt: "2026-11-12T12:00:00.000Z",
		});
		const settle = vi.fn();
		// SAFETY: reconcile touches only get, activeLeases, transition, settle.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle,
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockRejectedValue(
			new Error("correlation down"),
		);
		vi.spyOn(githubModule, "getJob").mockRejectedValue(
			new Error("temporary GitHub failure"),
		);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			list: vi.fn(async () => [
				{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
			]),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async () => false),
		};
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-11-12T12:03:00.000Z",
		});
		await controller.host.reconcile(lease.id);
		expect(settle).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("falls through correlation errors to getJob before settling", async () => {
		const leaseId = "correlation-fallthrough-getjob";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: GHCR_JOB,
			actualJobId: GHCR_JOB,
			originalRunId: RELEASE_RUN,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-fallthrough",
			sandboxStage: "running",
			state: "running",
			usageCompletedAt: "2026-11-12T12:02:00.000Z",
			createdAt: "2026-11-12T12:00:00.000Z",
		});
		const settle = vi.fn();
		const remove = vi.fn();
		// SAFETY: reconcile touches only get, activeLeases, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockRejectedValue(
			new Error("correlation down"),
		);
		vi.spyOn(githubModule, "getJob").mockResolvedValue({
			id: GHCR_JOB,
			run_id: RELEASE_RUN,
			status: "completed",
			labels: ["hobo"],
			runner_name: lease.runnerName,
			runner_id: lease.runnerId,
			run_attempt: 1,
		});
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove,
			list: vi.fn(async () => []),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async () => false),
		};
		const controller = createIsolatedContainerController({
			store,
			github: githubAllowRunnerDeregister(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-11-12T12:10:00.000Z",
		});
		await controller.host.reconcile(lease.id);
		expect(settle).toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	describe("forceStop vs JIT teardown guard", () => {
		function crossJobLeaseFixture(leaseId: string) {
			return create(LeaseSchema, {
				id: leaseId,
				accountId: "a",
				offerId: "box",
				provider: "hobo-box-worker",
				jobId: GHCR_JOB,
				actualJobId: SHARD_JOB,
				originalRunId: MAIN_RUN,
				runAttempt: 1,
				repositoryId: 101,
				repository: "Hobo-Labs/HoBo",
				installationId: 10,
				runnerName: `hobo-${leaseId}`,
				runnerId: 99,
				sandboxName: `hobo-${leaseId}`,
				sandboxSessionId: "cid-force",
				sandboxStage: "running",
				state: "running",
				createdAt: "2026-11-12T12:00:00.000Z",
			});
		}

		function crossJobGithubMocks(lease: Lease, shardStatus: string): void {
			vi.spyOn(githubModule, "getJob").mockImplementation(
				async (_api, _i, _r, jobId) => {
					if (jobId === GHCR_JOB)
						return {
							id: jobId,
							run_id: RELEASE_RUN,
							status: "queued",
							labels: ["hobo"],
							runner_name: null,
							run_attempt: 1,
						};
					return {
						id: jobId,
						run_id: MAIN_RUN,
						status: shardStatus,
						labels: ["hobo"],
						runner_name: lease.runnerName,
						runner_id: lease.runnerId,
						run_attempt: 1,
					};
				},
			);
			vi.spyOn(githubModule, "listRunWorkflowJobs").mockImplementation(
				async (_api, _i, _r, runId) => {
					if (runId === MAIN_RUN)
						return [
							{
								id: SHARD_JOB,
								run_id: MAIN_RUN,
								status: shardStatus,
								runner_name: lease.runnerName,
								runner_id: lease.runnerId,
							},
						];
					return [
						{
							id: GHCR_JOB,
							run_id: RELEASE_RUN,
							status: "queued",
							runner_name: null,
							runner_id: null,
						},
					];
				},
			);
			vi.spyOn(githubModule, "listInProgressWorkflowRunIds").mockImplementation(
				async () => (shardStatus === "in_progress" ? [MAIN_RUN] : []),
			);
		}

		it("does not kill the runner on forceStop while the served job is in_progress", async () => {
			const leaseId = "force-stop-in-progress";
			const lease = crossJobLeaseFixture(leaseId);
			const settle = vi.fn();
			const stop = vi.fn();
			const remove = vi.fn();
			// SAFETY: reconcile touches only get, activeLeases, transition, settle.
			const store = {
				get: async (id: string) => (id === lease.id ? lease : undefined),
				activeLeases: async () => [lease],
				transition: transitionFor(lease),
				settle,
			} as SqliteCiStore & HostedRelayStore;
			crossJobGithubMocks(lease, "in_progress");
			const docker: DockerDriver = {
				create: vi.fn(),
				start: vi.fn(),
				exec: vi.fn(),
				stop,
				remove,
				list: vi.fn(async () => [
					{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
				]),
				isRunning: vi.fn(async () => true),
				exists: vi.fn(async () => false),
			};
			const controller = createIsolatedContainerController({
				store,
				github: githubAllowRunnerDeregister(),
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => "2026-11-12T12:05:00.000Z",
			});
			await controller.host.reconcile(lease.id, true);
			expect(stop).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(settle).not.toHaveBeenCalled();
			vi.restoreAllMocks();
		});

		it("stops and settles on forceStop when the served job completed", async () => {
			const leaseId = "force-stop-completed";
			const lease = crossJobLeaseFixture(leaseId);
			const settle = vi.fn();
			const stop = vi.fn();
			const remove = vi.fn();
			// SAFETY: reconcile touches only get, activeLeases, transition, settle, withdrawQueuedJob.
			const store = {
				get: async (id: string) => (id === lease.id ? lease : undefined),
				activeLeases: async () => [lease],
				transition: transitionFor(lease),
				settle,
				withdrawQueuedJob: vi.fn(async () => true),
			} as SqliteCiStore & HostedRelayStore;
			crossJobGithubMocks(lease, "completed");
			const docker: DockerDriver = {
				create: vi.fn(),
				start: vi.fn(),
				exec: vi.fn(),
				stop,
				remove,
				list: vi.fn(async () => [
					{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
				]),
				isRunning: vi.fn(async () => true),
				exists: vi.fn(async () => false),
			};
			const controller = createIsolatedContainerController({
				store,
				github: githubAllowRunnerDeregister(),
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => "2026-11-12T12:10:00.000Z",
			});
			await controller.host.reconcile(lease.id, true);
			expect(stop).toHaveBeenCalled();
			expect(remove).toHaveBeenCalled();
			expect(settle).toHaveBeenCalled();
			vi.restoreAllMocks();
		});

		it("stops on forceStop when the assignment is queued past the grace window", async () => {
			const leaseId = "force-stop-queued-past-grace";
			const now = "2026-11-12T12:10:00.000Z";
			const lease = create(LeaseSchema, {
				...crossJobLeaseFixture(leaseId),
				jobId: GHCR_JOB,
				actualJobId: GHCR_JOB,
				originalRunId: RELEASE_RUN,
				createdAt: new Date(
					Date.parse(now) - (ISOLATED_JIT_QUEUED_BOUND_GRACE_MS + 60_000),
				).toISOString(),
			});
			const settle = vi.fn();
			const stop = vi.fn();
			const remove = vi.fn();
			// SAFETY: reconcile touches only get, activeLeases, transition, settle, withdrawQueuedJob.
			const store = {
				get: async (id: string) => (id === lease.id ? lease : undefined),
				activeLeases: async () => [lease],
				transition: transitionFor(lease),
				settle,
				withdrawQueuedJob: vi.fn(async () => true),
			} as SqliteCiStore & HostedRelayStore;
			vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockResolvedValue(
				{
					jobId: GHCR_JOB,
					runId: RELEASE_RUN,
					status: "queued",
				},
			);
			vi.spyOn(githubModule, "getJob").mockResolvedValue({
				id: GHCR_JOB,
				run_id: RELEASE_RUN,
				status: "queued",
				labels: ["hobo"],
				runner_name: lease.runnerName,
				runner_id: lease.runnerId,
				run_attempt: 1,
			});
			const docker: DockerDriver = {
				create: vi.fn(),
				start: vi.fn(),
				exec: vi.fn(),
				stop,
				remove,
				list: vi.fn(async () => [
					{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
				]),
				isRunning: vi.fn(async () => true),
				exists: vi.fn(async () => false),
			};
			const controller = createIsolatedContainerController({
				store,
				github: githubAllowRunnerDeregister(),
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => now,
			});
			await controller.host.reconcile(lease.id, true);
			expect(stop).toHaveBeenCalled();
			expect(settle).toHaveBeenCalled();
			vi.restoreAllMocks();
		});

		it("does not kill on forceStop when correlation fails but getJob shows in_progress", async () => {
			const leaseId = "force-stop-getjob-in-progress";
			const lease = crossJobLeaseFixture(leaseId);
			const settle = vi.fn();
			const stop = vi.fn();
			const remove = vi.fn();
			// SAFETY: reconcile touches only get, activeLeases, transition, settle.
			const store = {
				get: async (id: string) => (id === lease.id ? lease : undefined),
				activeLeases: async () => [lease],
				transition: transitionFor(lease),
				settle,
			} as SqliteCiStore & HostedRelayStore;
			vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockRejectedValue(
				new Error("correlation down"),
			);
			vi.spyOn(githubModule, "getJob").mockResolvedValue({
				id: SHARD_JOB,
				run_id: MAIN_RUN,
				status: "in_progress",
				labels: ["hobo"],
				runner_name: lease.runnerName,
				runner_id: lease.runnerId,
				run_attempt: 1,
			});
			const docker: DockerDriver = {
				create: vi.fn(),
				start: vi.fn(),
				exec: vi.fn(),
				stop,
				remove,
				list: vi.fn(async () => [
					{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
				]),
				isRunning: vi.fn(async () => true),
				exists: vi.fn(async () => false),
			};
			const controller = createIsolatedContainerController({
				store,
				github: deniedGithub(),
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => "2026-11-12T12:05:00.000Z",
			});
			await controller.host.reconcile(lease.id, true);
			expect(stop).not.toHaveBeenCalled();
			expect(settle).not.toHaveBeenCalled();
			vi.restoreAllMocks();
		});

		it("forceStop proceeds past unreadable GitHub on pre-kill while normal reconcile defers", async () => {
			const leaseId = "force-stop-unreadable-github";
			const lease = create(LeaseSchema, {
				id: leaseId,
				accountId: "a",
				offerId: "box",
				provider: "hobo-box-worker",
				jobId: GHCR_JOB,
				actualJobId: GHCR_JOB,
				originalRunId: RELEASE_RUN,
				runAttempt: 1,
				repositoryId: 101,
				repository: "Hobo-Labs/HoBo",
				installationId: 10,
				runnerName: `hobo-${leaseId}`,
				runnerId: 99,
				sandboxName: `hobo-${leaseId}`,
				sandboxSessionId: "cid-unreadable",
				sandboxStage: "running",
				state: "running",
				createdAt: "2026-11-12T12:00:00.000Z",
			});
			const settle = vi.fn();
			const stop = vi.fn();
			const remove = vi.fn();
			// SAFETY: reconcile touches only get, activeLeases, transition, settle.
			const store = {
				get: async (id: string) => (id === lease.id ? lease : undefined),
				activeLeases: async () => [lease],
				transition: transitionFor(lease),
				settle,
			} as SqliteCiStore & HostedRelayStore;
			vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockRejectedValue(
				new Error("correlation down"),
			);
			vi.spyOn(githubModule, "getJob").mockRejectedValue(
				new Error("temporary GitHub failure"),
			);
			const docker: DockerDriver = {
				create: vi.fn(),
				start: vi.fn(),
				exec: vi.fn(),
				stop,
				remove,
				list: vi.fn(async () => [
					{ name: lease.sandboxName, containerId: lease.sandboxSessionId },
				]),
				isRunning: vi.fn(async () => true),
				exists: vi.fn(async () => false),
			};
			const controller = createIsolatedContainerController({
				store,
				github: deniedGithub(),
				publicOrigin: "https://ci.example.test",
				docker,
				workerAccountId: "worker-a",
				workerImage: "hobo-ci-worker:local",
				now: () => "2026-11-12T12:05:00.000Z",
			});
			await controller.host.reconcile(lease.id);
			expect(stop).not.toHaveBeenCalled();
			stop.mockClear();
			await expect(controller.host.reconcile(lease.id, true)).rejects.toThrow(
				"temporary GitHub failure",
			);
			expect(stop).toHaveBeenCalled();
			vi.restoreAllMocks();
		});
	});

	it("orphan telemetry prefers the served job run id", () => {
		const lease = create(LeaseSchema, {
			id: "237f4d7d-0700-466a-9140-8cbc4d241cc7",
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			jobId: GHCR_JOB,
			actualJobId: SHARD_JOB,
			originalRunId: RELEASE_RUN,
			runnerId: 99,
			runnerName: "hobo-237f4d7d-0700-466a-9140-8cbc4d241cc7",
		});
		const candidate = orphanJobCandidateForLease(lease, 0, {
			jobId: SHARD_JOB,
			runId: MAIN_RUN,
		});
		if (!candidate) throw new Error("fixture candidate");
		expect(candidate.jobId).toBe(SHARD_JOB);
		expect(candidate.runId).toBe(MAIN_RUN);
	});
});

function deniedGithub(): GithubTransport {
	return {
		async request() {
			throw new Error("unexpected GitHub request");
		},
	};
}

function githubAllowRunnerDeregister(): GithubTransport {
	return {
		async request(_installationId, path, method) {
			if (method === "DELETE" && path.includes("/actions/runners/"))
				return new Response(null, { status: 204 });
			throw new Error(`unexpected ${method} ${path}`);
		},
	};
}
