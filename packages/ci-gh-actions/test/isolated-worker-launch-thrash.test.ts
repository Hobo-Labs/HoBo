import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { HostedRelay } from "../src/hosted-relay.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";
import type { WorkerStorageFileSystem } from "../src/isolated-worker/storage-admission.js";

const NOW = "2026-11-04T12:00:00.000Z";
const roots: string[] = [];
const stores: SqliteCiStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function launchFixture(extras?: {
	gitMirror?: {
		pathFor(repository: string): string | undefined;
		ensure?(
			repository: string,
			sha: string,
		): Promise<{ status: "hit" | "miss"; reason?: string; mirror?: string }>;
	};
	headShaFor?: (lease: { originalRunId: number }) => Promise<string | undefined>;
}) {
	const root = mkdtempSync(join(tmpdir(), "hobo-ci-launch-thrash-"));
	roots.push(root);
	const store = new SqliteCiStore(join(root, "worker.sqlite"));
	stores.push(store);
	const configuration = create(ConfigurationSchema, {
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
						observedAt: "2026-11-02T00:00:00.000Z",
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
	await store.configure(configuration, 0, NOW);
	const account = configuration.accounts[0];
	if (!account) throw new Error("fixture account");
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
	await store.queue(job, NOW, 1);
	const lease = await store.reserve(account, job, NOW, 1);
	if (!lease) throw new Error("fixture lease");
	const docker: DockerDriver = {
		create: vi.fn(async () => {
			throw new Error("docker create failed");
		}),
		start: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({ exitCode: 0 })),
		stop: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
		isRunning: vi.fn(async () => false),
		list: vi.fn(async () => []),
	};
	const retireJobDirectory = vi.fn(async (path: string) => `${path}-retired`);
	const removeJobDirectory = vi.fn(async () => ({ bytes: 128, entries: 4 }));
	const scheduleRetiredSweep = vi.fn();
	const workFs: WorkerStorageFileSystem = {
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
	const log = vi.fn();
	const github = githubFixture();
	const clock = { now: NOW };
	const gitMirror = extras?.gitMirror;
	const headShaFor = extras?.headShaFor;
	const controller = createIsolatedContainerController({
		store,
		github,
		publicOrigin: "https://ci.example.test",
		docker,
		workerAccountId: "worker-a",
		workerImage: "hobo-ci-worker:local",
		workRoot: join(root, "work"),
		workFs,
		scheduleRetiredSweep,
		now: () => clock.now,
		log,
		gitMirror,
		headShaFor,
	});
	return {
		clock,
		configuration,
		controller,
		docker,
		github,
		job,
		lease,
		log,
		scheduleRetiredSweep,
		store,
		workFs,
	};
}

function githubFixture(): GithubTransport {
	return {
		request: async (_installationId, path) => {
			if (path === "/repos/Org/Repo/actions/jobs/100")
				return Response.json({
					id: 100,
					run_id: 900,
					run_attempt: 1,
					status: "queued",
					labels: ["hobo"],
				});
			if (path === "/repos/Org/Repo/actions/runners/43")
				return Response.json({
					id: 43,
					name: "hobo-idle",
					busy: false,
					status: "online",
					labels: [{ name: "hobo" }],
				});
			if (path === "/repos/Org/Repo/actions/runs/900")
				return Response.json({
					id: 900,
					run_attempt: 1,
					event: "pull_request",
					head_sha: "a".repeat(40),
					head_branch: "branch",
					path: ".github/workflows/ci.yml",
					display_title: "CI",
					status: "in_progress",
					conclusion: null,
					run_started_at: NOW,
					updated_at: NOW,
					actor: { id: 1 },
					repository: { id: 101, private: false },
					head_repository: { id: 101 },
					pull_requests: [],
				});
			throw new Error(`unexpected GitHub request: ${path}`);
		},
	};
}

describe("isolated worker launch failure handling", () => {
	it("fetches the run head into the box mirror before docker create", async () => {
		const ensure = vi.fn(async () => ({
			status: "hit" as const,
			mirror: "/var/lib/hobo-ci/git/Org/Repo.git",
		}));
		const f = await launchFixture({
			gitMirror: {
				pathFor: () => "/var/lib/hobo-ci/git/Org/Repo.git",
				ensure,
			},
			headShaFor: async () => "a".repeat(40),
		});

		await f.controller.host.launch(f.lease.id);

		expect(ensure).toHaveBeenCalledWith("Org/Repo", "a".repeat(40));
		expect(f.log).toHaveBeenCalledWith(
			"hobo_ci_git_mirror",
			expect.objectContaining({
				status: "hit",
				repository: "Org/Repo",
				mirror: "/var/lib/hobo-ci/git/Org/Repo.git",
			}),
		);
	});

	it("logs the failed launch stage and job identity", async () => {
		const f = await launchFixture();

		await f.controller.host.launch(f.lease.id);

		expect(f.log).toHaveBeenCalledWith(
			"hobo_ci_launch_failed",
			expect.objectContaining({
				stage: "create",
				message: "docker create failed",
				leaseId: f.lease.id,
				jobId: 100,
				actualJobId: 0,
				attempt: 1,
			}),
		);
	});

	it("never treats a reserved lease as a missing container", async () => {
		const f = await launchFixture();
		await f.store.transition(
			f.lease.id,
			["reserved"],
			(lease) => {
				lease.createdAt = new Date(Date.parse(NOW) - 20 * 60_000).toISOString();
			},
			"ci.LeaseReserved",
			NOW,
			1,
		);

		await f.controller.reconcileLeases();

		expect(await f.store.get(f.lease.id)).toMatchObject({ state: "reserved" });
		expect(f.workFs.retireJobDirectory).not.toHaveBeenCalled();
		expect(f.workFs.removeJobDirectory).not.toHaveBeenCalled();
	});

	it("starts the missing-container grace at dispatch and protects an in-flight launch", async () => {
		const f = await launchFixture();
		await f.store.transition(
			f.lease.id,
			["reserved"],
			(lease) => {
				lease.createdAt = new Date(Date.parse(NOW) - 20 * 60_000).toISOString();
			},
			"ci.LeaseReserved",
			NOW,
			1,
		);
		let rejectCreate: ((error: Error) => void) | undefined;
		const createGate = new Promise<void>((_resolve, reject) => {
			rejectCreate = reject;
		});
		f.docker.create = vi.fn(async (spec) => {
			await createGate;
			return { name: spec.name, containerId: "a".repeat(64) };
		});
		const launching = f.controller.host.launch(f.lease.id);
		await vi.waitFor(() => expect(f.docker.create).toHaveBeenCalledOnce());
		const abort = vi.spyOn(f.store, "abortIsolatedAndRequeue");

		await f.controller.reconcileLeases();

		expect(await f.store.get(f.lease.id)).toMatchObject({
			state: "dispatching",
			dispatchingAt: NOW,
		});
		expect(abort).not.toHaveBeenCalled();
		expect(f.workFs.retireJobDirectory).not.toHaveBeenCalled();
		expect(f.workFs.removeJobDirectory).not.toHaveBeenCalled();
		rejectCreate?.(new Error("finish launch"));
		await launching;
	});

	it("parks a job after three containerless launch cycles for ten minutes", async () => {
		const f = await launchFixture();
		const relay = new HostedRelay({
			config: f.configuration,
			store: f.store,
			github: f.github,
			identity: {
				verify: async () => {
					throw new Error("not used");
				},
			},
			webhookSecret: "x".repeat(32),
			isolatedHost: f.controller.host,
			now: () => f.clock.now,
		});

		for (let attempt = 0; attempt < 3; attempt++) await relay.dispatchPending();

		expect(f.docker.create).toHaveBeenCalledTimes(3);
		expect(f.docker.start).not.toHaveBeenCalled();
		expect(f.workFs.prepareJobDirectory).toHaveBeenCalledTimes(3);
		expect(f.workFs.retireJobDirectory).toHaveBeenCalledTimes(3);
		expect(f.scheduleRetiredSweep).toHaveBeenCalledTimes(3);
		expect(f.workFs.removeJobDirectory).not.toHaveBeenCalled();
		expect(f.log).toHaveBeenCalledWith(
			"hobo_ci_launch_parked",
			expect.objectContaining({
				stage: "create",
				message: "docker create failed",
				jobId: 100,
				attempt: 3,
				failureCount: 3,
				parkMs: 600_000,
				windowMs: 1_800_000,
			}),
		);
		expect(await f.store.activeLeases()).toEqual([]);
		expect(await f.store.pendingJobs()).toEqual([]);

		await f.store.queue(f.job, f.clock.now, 1);
		await relay.dispatchPending();
		expect(f.docker.create).toHaveBeenCalledTimes(3);
		expect(await f.store.activeLeases()).toEqual([]);

		f.clock.now = new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
		await relay.dispatchPending();
		expect(f.docker.create).toHaveBeenCalledTimes(4);
	});

	it("lets a matching idle runner take a swapped runner's original job", async () => {
		const f = await launchFixture();
		const account = f.configuration.accounts[0];
		if (!account) throw new Error("fixture account");
		const idleJob = create(JobSchema, { ...f.job, id: 300 });
		await f.store.queue(idleJob, NOW, 1);
		const idle = await f.store.reserve(account, idleJob, NOW, 1);
		if (!idle) throw new Error("idle lease");
		await f.store.transition(
			f.lease.id,
			["reserved"],
			(lease) => {
				lease.state = "running";
				lease.actualJobId = 200;
				lease.runnerId = 42;
			},
			"ci.RunnerRegistered",
			NOW,
			1,
		);
		await f.store.transition(
			idle.id,
			["reserved"],
			(lease) => {
				lease.state = "running";
				lease.runnerId = 43;
			},
			"ci.RunnerRegistered",
			NOW,
			1,
		);
		const queue = vi.spyOn(f.store, "queue");
		const relay = new HostedRelay({
			config: f.configuration,
			store: f.store,
			github: f.github,
			identity: {
				verify: async () => {
					throw new Error("not used");
				},
			},
			webhookSecret: "x".repeat(32),
			isolatedHost: {
				launch: vi.fn(async () => undefined),
				reconcile: vi.fn(async () => undefined),
			},
			now: () => f.clock.now,
		});

		await relay.dispatchPending();

		expect(queue).not.toHaveBeenCalled();
		expect(
			new Set((await f.store.activeLeases()).map((lease) => lease.id)),
		).toEqual(new Set([f.lease.id, idle.id]));
	});
});
