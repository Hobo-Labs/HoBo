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
import {
	type JitEmptyExitState,
	jitEmptyExitKey,
	recordJitEmptyExit,
} from "../src/jit-empty-exit-backoff.js";
import type { GithubTransport } from "../src/github.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type { DockerDriver } from "../src/isolated-worker/docker-driver.js";

function deniedGithub(): GithubTransport {
	return {
		async request() {
			throw new Error("unexpected GitHub request");
		},
	};
}

const NOW = "2026-11-10T19:08:00.000Z";
const roots: string[] = [];
const stores: SqliteCiStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("jit empty exit launch guard", () => {
	it("skips launch while per-job backoff is active", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-jit-backoff-"));
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
							observedAt: "2026-11-02T00:00:00Z",
							validUntil: "2026-12-31T23:59:59Z",
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
		const job = create(JobSchema, {
			id: 100,
			runId: 900,
			runAttempt: 1,
			repositoryId: 101,
			installationId: 10,
			repository: "Org/Repo",
			labels: ["hobo-trunk"],
			action: "queued",
			isolatedRequired: true,
			memoryClass: "light",
			memoryMb: 3_072,
		});
		await store.queue(job, NOW, 1);
		const account = configuration.accounts[0];
		if (!account) throw new Error("account");
		const lease = await store.reserve(account, job, NOW, 1);
		if (!lease) throw new Error("lease");
		const docker: DockerDriver = {
			create: vi.fn(),
			start: vi.fn(),
			exec: vi.fn(),
			stop: vi.fn(),
			remove: vi.fn(),
			isRunning: vi.fn(async () => false),
			list: vi.fn(async () => []),
		};
		const log = vi.fn();
		const jitEmptyExitLoops = new Map<string, JitEmptyExitState>();
		recordJitEmptyExit(
			jitEmptyExitLoops,
			jitEmptyExitKey(101, 100, 1),
			Date.parse(NOW),
		);
		const controller = createIsolatedContainerController({
			store,
			github: deniedGithub(),
			publicOrigin: "https://ci.example.test",
			docker,
			workerAccountId: "worker-a",
			workerImage: "hobo-ci-worker:local",
			now: () => NOW,
			log,
			jitEmptyExitLoops,
		});
		expect(await controller.host.isLaunchParked(job)).toBe(true);
		await controller.host.launch(lease.id, "hobo-trunk");
		expect(docker.create).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_jit_empty_exit_backoff",
			expect.objectContaining({ jobId: 100, stage: "launch" }),
		);
	});
});
