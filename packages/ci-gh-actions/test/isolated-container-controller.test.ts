import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import type { PostgresCiStore } from "@hobo/ci/postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import * as githubModule from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import type { WorkerStorageFileSystem } from "../src/isolated-worker/storage-admission.js";
import { NOW } from "./fixtures.js";

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

describe("isolated container controller reconcile", () => {
	afterEach(() => {
		vi.restoreAllMocks();
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
		} as PostgresCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(),
		};
		// SAFETY: reconcile() does not call github in this scenario.
		const github = {} as GithubTransport;
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
		// SAFETY: force-stop reconcile only calls get() and settle(); this stub implements both.
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			settle,
		} as PostgresCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
		};
		// SAFETY: force-stop reconcile uses getJob(), not github.request().
		const github = {} as GithubTransport;
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
		// SAFETY: force-stop reconcile only calls get() and settle(); this stub implements both.
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			settle,
		} as PostgresCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
		};
		// SAFETY: force-stop reconcile uses getJob(), not github.request().
		const github = {} as GithubTransport;
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
		expect(settle.mock.calls[0]?.[4]).toMatchObject({
			id: lease.jobId,
			action: "queued",
			isolatedRequired: true,
		});
	});

	it("force-stop settle requeues when the reserved job is still queued and unassigned", async () => {
		const lease = runningLease({ jobId: 100, actualJobId: 0 });
		const settle = vi.fn(async () => lease);
		// SAFETY: force-stop reconcile only calls get() and settle(); this stub implements both.
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			settle,
		} as PostgresCiStore & HostedRelayStore;
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(async () => undefined),
			remove: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
		};
		// SAFETY: force-stop reconcile uses getJob(), not github.request().
		const github = {} as GithubTransport;
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
		expect(settle.mock.calls[0]?.[4]).toMatchObject({
			id: lease.jobId,
			labels: ["hobo"],
		});
	});

	it("does not abort a running lease when docker inspect fails", async () => {
		const lease = runningLease({ jobId: 100, actualJobId: 0 });
		const abortIsolatedAndRequeue = vi.fn(async () => undefined);
		// SAFETY: non-forced reconcile only calls get() and abortIsolatedAndRequeue().
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			abortIsolatedAndRequeue,
		} as PostgresCiStore & HostedRelayStore;
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
		const github = {} as GithubTransport;
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
	});

	function markerScenario(
		exists: DockerDriver["exists"],
		stopped = false,
		log?: ReturnType<typeof vi.fn>,
		workRoot?: string,
	) {
		const lease = runningLease({ jobId: 100, actualJobId: 0 });
		const settle = vi.fn(async () => lease);
		const abortIsolatedAndRequeue = vi.fn(async () => undefined);
		const work = workRoot ? workDirectory() : undefined;
		// SAFETY: reconcile() only calls get(), settle() and abortIsolatedAndRequeue().
		const relayStore = {
			get: async (id: string) => (id === lease.id ? lease : undefined),
			settle,
			abortIsolatedAndRequeue,
		} as PostgresCiStore & HostedRelayStore;
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
		// SAFETY: settle after a stop uses getJob(), not github.request().
		const github = {} as GithubTransport;
		const controllerOptions = {
			store: relayStore,
			github,
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "oracle-free-vm",
			workerImage: "hobo-ci-worker:local",
			now: () => "2026-10-26T12:02:00Z",
			log,
		};
		if (workRoot && work)
			Object.assign(controllerOptions, {
				workRoot,
				workFs: work.fs,
				scheduleRetiredSweep: work.scheduleRetiredSweep,
			});
		const controller = createIsolatedContainerController(controllerOptions);
		return { lease, settle, abortIsolatedAndRequeue, docker, controller, work };
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

	it("stops and settles a running lease once its runner wrote the exit marker", async () => {
		const exists = vi.fn(async () => true);
		const s = markerScenario(exists);
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
	});

	it("requeues the reserved job when the runner exited without taking it", async () => {
		const s = markerScenario(vi.fn(async () => true));
		vi.spyOn(githubModule, "getJob").mockResolvedValue(
			githubJob(s.lease.jobId, "queued"),
		);
		await s.controller.host.reconcile(s.lease.id);
		expect(s.settle.mock.calls[0]?.[4]).toMatchObject({
			id: s.lease.jobId,
			action: "queued",
			isolatedRequired: true,
		});
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
		expect(s.abortIsolatedAndRequeue).toHaveBeenCalledOnce();
		expect(s.work?.retireJobDirectory).toHaveBeenCalledWith(
			`/srv/hobo-ci/work/${s.lease.sandboxName}`,
		);
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
