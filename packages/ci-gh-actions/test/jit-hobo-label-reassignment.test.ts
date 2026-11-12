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
