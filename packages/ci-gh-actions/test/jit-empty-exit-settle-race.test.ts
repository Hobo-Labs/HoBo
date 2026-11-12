import { create } from "@bufbuild/protobuf";
import { JobSchema, type Lease, LeaseSchema } from "@hobo/ci";
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
import {
	type JitEmptyExitState,
	jitEmptyExitKey,
	jitEmptyExitLaunchBlocked,
} from "../src/jit-empty-exit-backoff.js";
import { jitRunnerDeregisterGithub } from "./github-deregister-mock.js";

function deniedGithub(): GithubTransport {
	return jitRunnerDeregisterGithub();
}

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

describe("jit empty exit settle race", () => {
	it("parks the next launch as soon as the exit marker appears, before settle", async () => {
		const leaseId = "00000000-0000-4000-8000-000000000099";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: 100,
			actualJobId: 0,
			originalRunId: 900,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Org/Repo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 42,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid",
			sandboxStage: "running",
			state: "running",
			createdAt: "2026-11-10T19:30:00.000Z",
		});
		const settle = vi.fn(async () => lease);
		const withdrawQueuedJob = vi.fn(async () => true);
		// SAFETY: reconcile uses get(), transition(), settle(), and withdrawQueuedJob().
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob,
		} as SqliteCiStore & HostedRelayStore;
		let resolveGetJob!: (
			value: Awaited<ReturnType<typeof githubModule.getJob>>,
		) => void;
		const getJobDeferred = new Promise<
			Awaited<ReturnType<typeof githubModule.getJob>>
		>((resolve) => {
			resolveGetJob = resolve;
		});
		vi.spyOn(githubModule, "getJob").mockReturnValue(getJobDeferred);
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockResolvedValue([
			{
				id: 100,
				run_id: 900,
				status: "queued",
				runner_name: null,
				runner_id: null,
			},
		]);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async (_n, _id, path) => path === RUNNER_EXITED_PATH),
		};
		const jitEmptyExitLoops = new Map<string, JitEmptyExitState>();
		const nowMs = Date.parse("2026-11-10T19:31:55.000Z");
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => new Date(nowMs).toISOString(),
			jitEmptyExitLoops,
		});
		const job = create(JobSchema, {
			id: 100,
			runId: 900,
			runAttempt: 1,
			repositoryId: 101,
			installationId: 10,
			repository: "Org/Repo",
			labels: ["hobo"],
			action: "queued",
			isolatedRequired: true,
			memoryClass: "light",
			memoryMb: 3_072,
		});
		const reconcile = controller.host.reconcile(lease.id);
		for (let tick = 0; tick < 50 && jitEmptyExitLoops.size === 0; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			jitEmptyExitLaunchBlocked(
				jitEmptyExitLoops,
				jitEmptyExitKey(101, 100, 1),
				nowMs,
			),
		).toBeDefined();
		expect(await controller.host.isLaunchParked(job)).toBe(true);
		resolveGetJob(githubJob(100, "queued"));
		await reconcile;
		vi.restoreAllMocks();
	});

	it("does not penalize backoff when GitHub shows the runner served another job on the run", async () => {
		const leaseId = "00000000-0000-4000-8000-000000000088";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: 100,
			actualJobId: 0,
			originalRunId: 900,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Org/Repo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 42,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid",
			sandboxStage: "running",
			state: "running",
			createdAt: "2026-11-10T19:30:00.000Z",
		});
		const settle = vi.fn(async () => lease);
		// SAFETY: reconcile uses get(), transition(), settle(), and withdrawQueuedJob().
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			transition: transitionFor(lease),
			settle,
			withdrawQueuedJob: vi.fn(async () => true),
		} as SqliteCiStore & HostedRelayStore;
		vi.spyOn(githubModule, "getJob").mockResolvedValue({
			id: 100,
			run_id: 900,
			status: "queued",
			labels: ["hobo"],
			runner_name: null,
			run_attempt: 1,
		});
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockResolvedValue([
			{
				id: 100,
				run_id: 900,
				status: "queued",
				runner_name: null,
				runner_id: null,
			},
			{
				id: 200,
				run_id: 900,
				status: "completed",
				runner_name: lease.runnerName,
				runner_id: 42,
			},
		]);
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => false),
			exists: vi.fn(async (_n, _id, path) => path === RUNNER_EXITED_PATH),
		};
		const jitEmptyExitLoops = new Map<string, JitEmptyExitState>();
		const log = vi.fn();
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-11-10T19:32:00.000Z",
			jitEmptyExitLoops,
			log,
		});
		await controller.host.reconcile(lease.id);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_jit_runner_served_other_job",
			expect.objectContaining({ reservedJobId: 100, servedJobId: 200 }),
		);
		expect(log).not.toHaveBeenCalledWith(
			"hobo_ci_jit_empty_exit",
			expect.anything(),
		);
		expect(jitEmptyExitLoops.has(jitEmptyExitKey(101, 100, 1))).toBe(false);
		vi.restoreAllMocks();
	});
});

function githubJob(
	id: number,
	status: string,
	runnerName: string | null = null,
) {
	return {
		id,
		run_id: 900,
		status,
		labels: ["hobo"],
		runner_name: runnerName,
		run_attempt: 1,
	};
}
