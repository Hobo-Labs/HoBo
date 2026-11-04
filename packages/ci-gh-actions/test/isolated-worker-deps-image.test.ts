import { randomUUID } from "node:crypto";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type {
	DockerDriver,
	DockerImageInspection,
	IsolatedContainerSpec,
} from "../src/isolated-worker/docker-driver.js";

const NOW = "2026-11-02T12:00:00Z";
const TOOLCHAIN = "v0123456789ab";
const DEPS_KEY = `${TOOLCHAIN}-0123456789abcdef`;

function fakeDocker() {
	const specs: IsolatedContainerSpec[] = [];
	const inspectCalls: string[] = [];
	const images = new Map<string, DockerImageInspection | Error>([
		[
			"hobo-ci-worker:local",
			{
				id: "worker-id",
				repoTags: ["hobo-ci-worker:local", `hobo-ci-worker:${TOOLCHAIN}`],
				labels: {},
			},
		],
		[
			"hobo-ci-deps:local",
			{
				id: "deps-id",
				repoTags: ["hobo-ci-deps:local"],
				labels: {
					"hobo.ci.deps-key": DEPS_KEY,
					"hobo.ci.toolchain": TOOLCHAIN,
				},
			},
		],
	]);
	let next = 0;
	const resourceUpdates: { containerId: string; cpuShares: number }[] = [];
	const driver: DockerDriver = {
		inspectImage: vi.fn(async (image: string) => {
			inspectCalls.push(image);
			const inspection = images.get(image);
			if (inspection instanceof Error) throw inspection;
			if (!inspection) throw new Error(`missing image ${image}`);
			return inspection;
		}),
		create: vi.fn(async (spec) => {
			specs.push(spec);
			next += 1;
			return { name: spec.name, containerId: String(next).padStart(64, "0") };
		}),
		start: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({ exitCode: 0 })),
		execDetached: vi.fn(async () => ({ exitCode: 0 })),
		writeSecret: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		updateResources: vi.fn(async (containerId, weights) => {
			resourceUpdates.push({ containerId, cpuShares: weights.cpuShares });
		}),
		stop: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
		isRunning: vi.fn(async () => true),
	};
	return { driver, specs, resourceUpdates, inspectCalls, images };
}

const github: GithubTransport = {
	request: async () =>
		Response.json(
			{ encoded_jit_config: "c2VjcmV0", runner: { id: 42 } },
			{ status: 201 },
		),
};

describe("isolated worker deps image selection", () => {
	let root = "";
	let store: SqliteCiStore | undefined;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hobo-ci-deps-image-"));
	});
	afterEach(() => {
		store?.close();
		rmSync(root, { recursive: true, force: true });
	});

	async function reservedLease(repository: string) {
		store = new SqliteCiStore(join(root, `${randomUUID()}.sqlite`));
		await store.configure(
			create(ConfigurationSchema, {
				accounts: [
					create(AccountSchema, {
						id: "hobo-labs",
						maxRuntimeMinutes: 30,
						startupMinutes: 5,
						offers: [
							create(OfferSchema, {
								id: "box-isolated",
								provider: "kubernetes",
								providerAccountId: "box",
								enabled: true,
								runsOn: "hobo-isolated-worker",
								backend: "isolated-container",
								concurrency: 1,
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
						accountId: "hobo-labs",
						installationId: 10,
						repositoryId: 101,
						repository,
						runnerGroupId: 1,
						isolatedOnly: true,
						acceptAllMatchingRepositoryJobs: true,
						trustedRepositoryAcknowledged: true,
						publicRepositoryAcknowledged: true,
					}),
				],
			}),
			0,
			NOW,
		);
		const configured = await store.configuration();
		const account = configured?.configuration.accounts[0];
		if (!configured || !account) throw new Error("missing fixture account");
		const job = create(JobSchema, {
			id: 1,
			runId: 11,
			runAttempt: 1,
			repositoryId: 101,
			installationId: 10,
			repository,
			labels: ["hobo"],
			action: "queued",
			isolatedRequired: true,
		});
		await store.queue(job, NOW, configured.revision);
		const lease = await store.reserve(account, job, NOW, configured.revision);
		if (!lease) throw new Error("fixture lease was not reserved");
		return lease;
	}

	function controller(driver: DockerDriver, workRoot?: string) {
		if (!store) throw new Error("fixture store not initialized");
		const workFs = {
			statfs: vi.fn(async () => ({
				blocks: 100,
				bfree: 100,
				files: 100,
				ffree: 100,
			})),
			jobDirectories: vi.fn(async () => []),
			prepareJobDirectory: vi.fn(async () => undefined),
			removeJobDirectory: vi.fn(async () => ({ bytes: 0, entries: 0 })),
		};
		const controllerOptions = {
			store,
			github,
			publicOrigin: "https://relay.example",
			docker: driver,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			slots: 1,
			now: () => NOW,
		};
		if (workRoot !== undefined)
			Object.assign(controllerOptions, { workRoot, workFs });
		return createIsolatedContainerController(controllerOptions);
	}

	it("uses the deps image and exports its key for a HoBo lease", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs).toHaveLength(1);
		expect(docker.specs[0]?.image).toBe("hobo-ci-deps:local");
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBe(DEPS_KEY);
	});

	it("gives trunk containers high CPU and IO weights and PR containers low weights", async () => {
		const trunkLease = await reservedLease("Hobo-Labs/HoBo");
		const trunkDocker = fakeDocker();
		await controller(trunkDocker.driver).host.launch(trunkLease.id, "hobo", 0);
		expect(trunkDocker.specs[0]).toMatchObject({
			cpuShares: 8_192,
			blkioWeight: 800,
		});

		const prLease = await reservedLease("Hobo-Labs/HoBo");
		const prDocker = fakeDocker();
		await controller(prDocker.driver).host.launch(prLease.id, "hobo", 1);
		expect(prDocker.specs[0]).toMatchObject({
			cpuShares: 512,
			blkioWeight: 200,
		});
	});

	it("starts a warm spare at PR weight and updates it for trunk assignment", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const ctl = controller(docker.driver);
		await ctl.prewarm("Hobo-Labs/HoBo");
		expect(docker.specs[0]).toMatchObject({
			cpuShares: 512,
			blkioWeight: 200,
		});
		await ctl.host.launch(lease.id, "hobo-trunk", 0);
		expect(docker.specs).toHaveLength(1);
		expect(docker.resourceUpdates).toEqual([
			{ containerId: "0".repeat(63) + "1", cpuShares: 8_192 },
		]);
	});

	it("does not claim the deps layer when a job directory hides it", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		const workRoot = join(root, "work");
		await controller(docker.driver, workRoot).host.launch(lease.id);
		expect(docker.specs).toHaveLength(1);
		expect(docker.specs[0]?.image).toBe("hobo-ci-deps:local");
		expect(docker.specs[0]?.volumes).toContainEqual({
			source: join(workRoot, `hobo-${lease.id}`),
			target: "/opt/actions-runner/_hobo_work",
		});
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBeUndefined();
	});

	it("falls back when the deps toolchain does not match", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const deps = docker.images.get("hobo-ci-deps:local");
		if (!deps || deps instanceof Error) throw new Error("missing fixture");
		docker.images.set("hobo-ci-deps:local", {
			...deps,
			labels: { ...deps.labels, "hobo.ci.toolchain": "v111111111111" },
		});
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBeUndefined();
	});

	it("never selects the HoBo deps image for another repository", async () => {
		const lease = await reservedLease("Hobo-Labs/ts-autocode");
		const docker = fakeDocker();
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
		expect(docker.inspectCalls).toEqual([]);
	});

	it("falls back when the deps image is missing", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		docker.images.set("hobo-ci-deps:local", new Error("missing"));
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
	});

	it("creates a fresh container instead of taking a mismatched prewarm", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const ctl = controller(docker.driver);
		await ctl.prewarm("Hobo-Labs/ts-autocode");
		await ctl.host.launch(lease.id);
		expect(docker.specs.map((spec) => spec.image)).toEqual([
			"hobo-ci-worker:local",
			"hobo-ci-deps:local",
		]);
		expect(docker.driver.rename).not.toHaveBeenCalled();
	});
});
