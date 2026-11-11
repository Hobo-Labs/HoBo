import { create } from "@bufbuild/protobuf";
import { type Lease, LeaseSchema } from "@hobo/ci";
import type { PostgresCiStore } from "@hobo/ci/postgres";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import * as githubModule from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";

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

describe("arc takes reserved trunk job", () => {
	it("keeps the container while GitHub assigned a different hobo-trunk job on another run", async () => {
		const leaseId = "7419296e-2bbf-40ef-a2a0-83ccf4ad2283";
		const lease = create(LeaseSchema, {
			id: leaseId,
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			jobId: 130234532217,
			actualJobId: 0,
			originalRunId: 42932527285,
			runAttempt: 1,
			repositoryId: 101,
			repository: "Hobo-Labs/HoBo",
			installationId: 10,
			runnerName: `hobo-${leaseId}`,
			runnerId: 99,
			sandboxName: `hobo-${leaseId}`,
			sandboxSessionId: "cid-deps",
			sandboxStage: "running",
			state: "running",
			createdAt: "2026-11-10T19:30:00.000Z",
		});
		// SAFETY: reconcile touches only get, transition, settle, withdrawQueuedJob.
		const store = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			activeLeases: async () => [lease],
			transition: transitionFor(lease),
			settle: vi.fn(),
			withdrawQueuedJob: vi.fn(async () => true),
		} as PostgresCiStore & HostedRelayStore;
		const probeRunJobs = [
			{
				id: 130234532217,
				run_id: 42932527285,
				status: "completed",
				runner_name: "hobo-trunk-runner-ws4z7",
				runner_id: 1,
			},
		];
		const depsRunJobs = [
			{
				id: 130234722114,
				run_id: 42932519565,
				status: "in_progress",
				runner_name: lease.runnerName,
				runner_id: lease.runnerId,
			},
		];
		vi.spyOn(githubModule, "getJob").mockImplementation(
			async (_api, _i, _r, jobId) => {
				if (jobId === 130234532217)
					return {
						id: jobId,
						run_id: 42932527285,
						status: "completed",
						labels: ["hobo-trunk"],
						runner_name: "hobo-trunk-runner-ws4z7",
						run_attempt: 1,
					};
				return {
					id: jobId,
					run_id: 42932519565,
					status: "in_progress",
					labels: ["hobo-trunk"],
					runner_name: lease.runnerName,
					run_attempt: 1,
				};
			},
		);
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockImplementation(
			async (_api, _i, _r, runId) => {
				if (runId === 42932527285) return probeRunJobs;
				if (runId === 42932519565) return depsRunJobs;
				return [];
			},
		);
		vi.spyOn(githubModule, "listInProgressWorkflowRunIds").mockResolvedValue([
			42932519565,
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
		const log = vi.fn();
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-11-10T19:32:00.000Z",
			log,
		});
		await controller.host.reconcile(lease.id, true);
		expect(stop).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(lease.actualJobId).toBe(130234722114);
		expect(lease.originalRunId).toBe(42932527285);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_jit_runner_custody_transferred",
			expect.objectContaining({ servedJobId: 130234722114 }),
		);
		vi.restoreAllMocks();
	});
});

function deniedGithub(): GithubTransport {
	return {
		async request() {
			throw new Error("unexpected GitHub request");
		},
	};
}
