import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgresCiStore } from "@hobo/ci/postgres";
import * as githubModule from "../src/github.js";
import type { GithubTransport } from "../src/github.js";
import type { HostedRelayStore } from "../src/hosted-relay.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import { NOW } from "./fixtures.js";

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
});
