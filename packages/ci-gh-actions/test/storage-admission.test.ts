import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	chown,
	lstat,
	mkdir,
	readdir,
	rename,
	rm,
	rmdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerImage } from "../src/isolated-worker/image-gc.js";
import {
	createNodeWorkerStorageFileSystem,
	createWorkerStorageAdmission,
	type WorkerFileSystemStats,
	type WorkerStorageDockerDriver,
	type WorkerStorageFileSystem,
	type WorkerStorageLease,
	type WorkerStoragePnpmStore,
} from "../src/isolated-worker/storage-admission.js";
import {
	DEPS_BUILD_ADMISSION_ID,
	storageReserveForJob,
} from "../src/isolated-worker/storage-job-classes.js";

const nodeFs = {
	chown: vi.fn<typeof chown>(),
	mkdir: vi.fn<typeof mkdir>(),
};

const DOCKER_ROOT = "/var/lib/docker";
const WORK_ROOT = "/srv/hobo-ci/work";
const LIVE = "hobo-00000000-0000-4000-8000-000000000001";
const DEAD = "hobo-00000000-0000-4000-8000-000000000002";
const STOPPED = "hobo-00000000-0000-4000-8000-000000000003";
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function usage(percent: number): WorkerFileSystemStats {
	return {
		blocks: 1_000_000,
		bfree: Math.floor(1_000_000 * (1 - percent / 100)),
		files: 100,
		ffree: 100 - percent,
		bsize: 4096,
	};
}

function harness(
	input: {
		before?: WorkerFileSystemStats;
		after?: WorkerFileSystemStats;
		devices?: Readonly<Record<string, number>>;
		directories?: readonly string[];
		jobDirectories?: WorkerStorageFileSystem["jobDirectories"];
		activeLeases?: () => Promise<readonly WorkerStorageLease[]>;
		existingContainers?: ReadonlySet<string>;
		images?: readonly WorkerImage[];
		jobInodes?: Readonly<{ workRoot: number; dockerDataRoot: number }>;
		defaultJobReserve?: import("../src/isolated-worker/storage-job-classes.js").WorkerStorageReserve;
		pnpmStoreIdle?: () => Promise<boolean>;
		prune?: WorkerStoragePnpmStore["prune"];
		now?: () => number;
		log?: ReturnType<typeof vi.fn>;
	} = {},
) {
	let current = input.before ?? usage(20);
	const retired: string[] = [];
	const scheduleRetiredSweep = vi.fn();
	const fs: WorkerStorageFileSystem = {
		statfs: vi.fn(async () => current),
		device: vi.fn(async (path: string) => input.devices?.[path] ?? 1),
		jobDirectories: vi.fn(
			input.jobDirectories ?? (async () => input.directories ?? []),
		),
		retiredDirectories: vi.fn(async () => []),
		prepareJobDirectory: vi.fn(async () => undefined),
		retireJobDirectory: vi.fn(async (path: string) => {
			const retiredPath = join(
				dirname(path),
				".retired",
				`${basename(path)}-test`,
			);
			retired.push(retiredPath);
			return retiredPath;
		}),
		removeJobDirectory: vi.fn(async () => ({ bytes: 128, entries: 4 })),
	};
	const docker: WorkerStorageDockerDriver = {
		dataRoot: vi.fn(async () => DOCKER_ROOT),
		pruneBuilder: vi.fn(async () => {
			current = input.after ?? current;
		}),
		containerExists: vi.fn(
			async (name: string) => input.existingContainers?.has(name) ?? false,
		),
		containersUsingVolume: vi.fn(async () => 0),
		listImages: vi.fn(async () => input.images ?? []),
		removeImage: vi.fn(async () => undefined),
		pruneDanglingImages: vi.fn(async () => undefined),
	};
	const pnpmStore: WorkerStoragePnpmStore = {
		prune: vi.fn(input.prune ?? (async () => ({ result: "pruned", ms: 1 }))),
	};
	const admission = createWorkerStorageAdmission({
		dockerDataRoot: DOCKER_ROOT,
		workRoot: WORK_ROOT,
		fs,
		docker,
		activeLeases: input.activeLeases ?? (async () => []),
		pnpmStore,
		pnpmStoreIdle: input.pnpmStoreIdle,
		jobInodes: input.jobInodes ?? { workRoot: 0, dockerDataRoot: 0 },
		defaultJobReserve: input.defaultJobReserve ?? {
			workRoot: input.jobInodes?.workRoot ?? 0,
			dockerDataRoot: input.jobInodes?.dockerDataRoot ?? 0,
			workRootBytes: 0,
			dockerDataRootBytes: 0,
		},
		scheduleRetiredSweep,
		now: input.now,
		log: input.log,
	});
	return {
		admission,
		docker,
		fs,
		pnpmStore,
		retired,
		scheduleRetiredSweep,
		setStats(stats: WorkerFileSystemStats) {
			current = stats;
		},
	};
}

function freeInodes(ffree: number): WorkerFileSystemStats {
	return {
		blocks: 10_000_000,
		bfree: 10_000_000,
		files: 1_000_000,
		ffree,
		bsize: 4096,
	};
}

describe("worker storage admission", () => {
	it("dedupes shared-device inode reserves and bins packs concurrent jobs", async () => {
		const log = vi.fn();
		const h = harness({
			before: freeInodes(497_710),
			jobInodes: { workRoot: 200_000, dockerDataRoot: 170_000 },
			log,
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		await expect(
			h.admission.admit(
				[{ id: "lease-1", sandboxName: "", jobId: "job-1" }],
				"job-2",
			),
		).resolves.toBe(true);
		expect(
			log.mock.calls.filter(
				([event]) => event === "hobo_ci_inode_reserve_wait",
			),
		).toHaveLength(0);
	});

	it("subtracts consumption since the oldest grant from outstanding growth", async () => {
		const h = harness({
			before: freeInodes(870_000),
			jobInodes: { workRoot: 200_000, dockerDataRoot: 170_000 },
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		h.setStats(freeInodes(500_000));
		await expect(
			h.admission.admit(
				[{ id: "lease-1", sandboxName: "", jobId: "job-1" }],
				"job-2",
			),
		).resolves.toBe(true);
	});

	it("holds the deps image build grant without a lease until it is released", async () => {
		let nowMs = 0;
		const reserve = {
			workRoot: 0,
			dockerDataRoot: 300_000,
			workRootBytes: 0,
			dockerDataRootBytes: 0,
		};
		const h = harness({ before: freeInodes(500_000), now: () => nowMs });
		// A job's grant with no lease lapses after the grace period.
		await expect(h.admission.admit([], "job-0", reserve)).resolves.toBe(true);
		nowMs += 60_000;
		await expect(
			h.admission.admit([], DEPS_BUILD_ADMISSION_ID, reserve),
		).resolves.toBe(true);
		// The build holds no lease, and its grant still counts after the grace period.
		nowMs += 60_000;
		await expect(h.admission.admit([], "job-1", reserve)).resolves.toBe(false);
		h.admission.release(DEPS_BUILD_ADMISSION_ID);
		await expect(h.admission.admit([], "job-1", reserve)).resolves.toBe(true);
	});

	it("checks reserves independently on different devices", async () => {
		const h = harness({
			before: freeInodes(500_000),
			devices: { [DOCKER_ROOT]: 1, [WORK_ROOT]: 2 },
			jobInodes: { workRoot: 200_000, dockerDataRoot: 170_000 },
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		await expect(
			h.admission.admit(
				[{ id: "lease-1", sandboxName: "", jobId: "job-1" }],
				"job-2",
			),
		).resolves.toBe(true);
	});

	it("releases a grant when its reservation fails", async () => {
		const h = harness({
			before: freeInodes(500_000),
			jobInodes: { workRoot: 200_000, dockerDataRoot: 170_000 },
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		h.admission.release("job-1");
		await expect(h.admission.admit([], "job-2")).resolves.toBe(true);
	});

	it("expires a grant without an active lease after the grace period", async () => {
		let nowMs = 0;
		const h = harness({
			before: freeInodes(380_000),
			jobInodes: { workRoot: 200_000, dockerDataRoot: 170_000 },
			now: () => nowMs,
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		nowMs = 15_000;
		await expect(h.admission.admit([], "job-2")).resolves.toBe(false);
		nowMs = 15_001;
		await expect(h.admission.admit([], "job-2")).resolves.toBe(true);
	});

	it("refuses a second release job when byte headroom is short", async () => {
		const log = vi.fn();
		const releaseReserve = storageReserveForJob("Publish GitHub Pages (site/)");
		const neededBytes = Math.max(
			releaseReserve.workRootBytes,
			releaseReserve.dockerDataRootBytes,
		);
		const bfree = Math.floor(neededBytes / 4096) + 500_000;
		const h = harness({
			before: {
				blocks: bfree + 1_000_000,
				bfree,
				files: 2_000_000,
				ffree: 1_500_000,
				bsize: 4096,
			},
			defaultJobReserve: releaseReserve,
			log,
		});
		await expect(h.admission.admit([], "job-1", releaseReserve)).resolves.toBe(
			true,
		);
		await expect(h.admission.admit([], "job-2", releaseReserve)).resolves.toBe(
			false,
		);
		expect(
			log.mock.calls.some(([event]) => event === "hobo_ci_disk_reserve_wait"),
		).toBe(true);
	});

	it("allows zero to disable both inode reservations", async () => {
		const h = harness({
			before: { ...freeInodes(100), files: 1_000 },
			jobInodes: { workRoot: 0, dockerDataRoot: 0 },
			defaultJobReserve: {
				workRoot: 0,
				dockerDataRoot: 0,
				workRootBytes: 0,
				dockerDataRootBytes: 0,
			},
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		await expect(h.admission.admit([], "job-2")).resolves.toBe(true);
	});

	it("rejects invalid inode reserve configuration", () => {
		for (const reserve of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
			expect(() =>
				harness({
					jobInodes: { workRoot: reserve, dockerDataRoot: 0 },
				}),
			).toThrow("invalid worker job storage reservation");
		expect(() =>
			harness({ jobInodes: { workRoot: 0, dockerDataRoot: -1 } }),
		).toThrow("invalid worker job storage reservation");
	});

	// The job mount belongs to the runner image's user, 1000. Only that user
	// and root may give a directory to it, so this runs on the fleet's image and
	// as root; on a machine with another user (a GitHub-hosted one is 1001) the
	// chown is refused before anything is asserted. The next test covers the
	// same preparation with the file system injected.
	const mayOwnAsRunner = [0, 1000].includes(process.getuid?.() ?? -1);
	it.runIf(mayOwnAsRunner)(
		"prepares owned checkout directories inside each job mount",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "hobo-worker-prepare-"));
			try {
				const job = join(root, LIVE);
				await createNodeWorkerStorageFileSystem().prepareJobDirectory(job);
				for (const directory of [
					job,
					join(job, "HoBo"),
					join(job, "HoBo", "HoBo"),
				]) {
					const metadata = statSync(directory);
					expect(metadata.uid).toBe(1000);
					expect(metadata.gid).toBe(1000);
					expect(metadata.mode & 0o200).not.toBe(0);
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("prepares a job-owned checkout directory inside the lease root", async () => {
		nodeFs.mkdir.mockResolvedValue(undefined);
		nodeFs.chown.mockResolvedValue(undefined);
		const directory = join(WORK_ROOT, LIVE);
		const repository = join(directory, "HoBo");
		const checkout = join(repository, "HoBo");
		await createNodeWorkerStorageFileSystem(nodeFs).prepareJobDirectory(
			directory,
		);
		expect(nodeFs.mkdir).toHaveBeenNthCalledWith(1, directory, {
			recursive: true,
			mode: 0o755,
		});
		expect(nodeFs.mkdir).toHaveBeenNthCalledWith(2, checkout, {
			recursive: true,
			mode: 0o755,
		});
		expect(nodeFs.chown).toHaveBeenNthCalledWith(1, repository, 1000, 1000);
		expect(nodeFs.chown).toHaveBeenNthCalledWith(2, checkout, 1000, 1000);
		expect(nodeFs.chown).toHaveBeenNthCalledWith(3, directory, 1000, 1000);
	});

	it("retires a job directory atomically and returns undefined when it is absent", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-worker-retire-"));
		temporaryRoots.push(root);
		const job = join(root, LIVE);
		mkdirSync(job);
		writeFileSync(join(job, "artifact"), "content");
		const fs = createNodeWorkerStorageFileSystem();

		const retired = await fs.retireJobDirectory(job);
		if (!retired) throw new Error("job directory was not retired");
		expect(dirname(retired)).toBe(join(root, ".retired"));
		expect(basename(retired)).toMatch(/^hobo-[0-9a-f-]{36}-[0-9a-z]+$/u);
		expect(existsSync(job)).toBe(false);
		expect(existsSync(retired)).toBe(true);
		expect(statSync(join(root, ".retired")).mode & 0o777).toBe(0o700);
		expect(await fs.retiredDirectories(root)).toEqual([retired]);
		await expect(fs.retireJobDirectory(job)).resolves.toBeUndefined();
	});

	it("treats only a missing entry as absent, and rethrows every other failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-worker-absent-"));
		temporaryRoots.push(root);
		// No `.retired` root yet: nothing has been retired on this host.
		expect(
			await createNodeWorkerStorageFileSystem().retiredDirectories(root),
		).toEqual([]);

		const denied = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});
		const fs = createNodeWorkerStorageFileSystem({
			chown,
			mkdir,
			readdir: vi.fn(async () => {
				throw denied;
			}),
			rename: vi.fn(async () => {
				throw denied;
			}),
		});
		await expect(fs.retiredDirectories(root)).rejects.toBe(denied);
		await expect(fs.retireJobDirectory(join(root, LIVE))).rejects.toBe(denied);
	});

	it("deletes a retired tree bottom-up with one traversal and counts as it goes", async () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-worker-remove-"));
		temporaryRoots.push(root);
		const job = join(root, LIVE);
		const nested = join(job, "nested");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(job, "first"), "abc");
		writeFileSync(join(nested, "second"), "12345");
		const operations = {
			chown,
			mkdir,
			lstat: vi.fn<typeof lstat>(lstat),
			readdir: vi.fn<typeof readdir>(readdir),
			rename: vi.fn<typeof rename>(rename),
			rm: vi.fn<typeof rm>(rm),
			rmdir: vi.fn<typeof rmdir>(rmdir),
		};
		const fs = createNodeWorkerStorageFileSystem(operations);
		const retired = await fs.retireJobDirectory(job);
		if (!retired) throw new Error("job directory was not retired");

		await expect(fs.removeJobDirectory(retired)).resolves.toEqual({
			bytes: 8,
			entries: 4,
		});
		expect(operations.lstat).toHaveBeenCalledTimes(4);
		expect(operations.readdir).toHaveBeenCalledTimes(2);
		expect(operations.rm).toHaveBeenCalledTimes(2);
		expect(operations.rmdir).toHaveBeenCalledTimes(2);
		expect(existsSync(retired)).toBe(false);
	});

	it("does not prune below either 85 percent threshold", async () => {
		const h = harness({ before: usage(85) });
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		expect(h.docker.pruneBuilder).not.toHaveBeenCalled();
		expect(h.fs.jobDirectories).not.toHaveBeenCalled();
	});

	it("prunes above threshold, samples both roots again, and admits below the hard limit", async () => {
		const h = harness({ before: usage(90), after: usage(80) });
		await expect(h.admission.admit([], "job-1")).resolves.toBe(true);
		expect(h.docker.pruneBuilder).toHaveBeenCalledWith("4GB");
		expect(h.fs.statfs).toHaveBeenCalledTimes(4);
		expect(h.fs.statfs).toHaveBeenCalledWith(DOCKER_ROOT);
		expect(h.fs.statfs).toHaveBeenCalledWith(WORK_ROOT);
	});

	it("runs admission maintenance at most once per interval", async () => {
		let nowMs = 1_000;
		const h = harness({
			before: usage(96),
			after: usage(96),
			now: () => nowMs,
		});
		await expect(h.admission.admit([], "job-1")).resolves.toBe(false);
		await expect(h.admission.admit([], "job-2")).resolves.toBe(false);
		expect(h.docker.pruneBuilder).toHaveBeenCalledOnce();

		nowMs += 60_000;
		await expect(h.admission.admit([], "job-3")).resolves.toBe(false);
		expect(h.docker.pruneBuilder).toHaveBeenCalledTimes(2);
	});

	it("blocks still-high filesystems and logs one pressure event per episode", async () => {
		const log = vi.fn();
		const h = harness({ before: usage(96), after: usage(96), log });
		await expect(h.admission.admit([], "job-1")).resolves.toBe(false);
		await expect(h.admission.admit([], "job-1")).resolves.toBe(false);
		expect(
			log.mock.calls.filter(([event]) => event === "hobo_ci_inode_pressure"),
		).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_inode_pressure",
			expect.objectContaining({
				pressureKind: "both",
				diskUsagePercent: 96,
				inodeUsagePercent: 96,
			}),
		);
	});

	it("never deletes a live job directory or one whose container still exists", async () => {
		const activeLeases = [
			{
				id: LIVE.slice("hobo-".length),
				sandboxName: LIVE,
				jobId: "job-1",
			},
		];
		const h = harness({
			before: usage(90),
			after: usage(80),
			directories: [LIVE, DEAD, STOPPED].map((name) => `${WORK_ROOT}/${name}`),
			activeLeases: async () => activeLeases,
			existingContainers: new Set([STOPPED]),
		});
		await expect(h.admission.admit(activeLeases, "job-2")).resolves.toBe(true);
		expect(h.retired).toEqual([`${WORK_ROOT}/.retired/${DEAD}-test`]);
		expect(h.fs.removeJobDirectory).not.toHaveBeenCalled();
		expect(h.scheduleRetiredSweep).toHaveBeenCalledOnce();
		expect(h.docker.containerExists).not.toHaveBeenCalledWith(LIVE);
		expect(h.docker.containerExists).toHaveBeenCalledWith(STOPPED);
	});

	it("reads leases after listing directories before reaping", async () => {
		let activeLeases: readonly WorkerStorageLease[] = [];
		const h = harness({
			activeLeases: async () => activeLeases,
			jobDirectories: async () => {
				activeLeases = [
					{
						id: LIVE.slice("hobo-".length),
						sandboxName: LIVE,
						jobId: "job-1",
					},
				];
				return [LIVE, DEAD].map((name) => `${WORK_ROOT}/${name}`);
			},
		});

		await h.admission.reap();

		expect(h.retired).toEqual([`${WORK_ROOT}/.retired/${DEAD}-test`]);
		expect(h.docker.containerExists).not.toHaveBeenCalledWith(LIVE);
	});

	it("keeps dispatching and claiming directories before their containers exist", async () => {
		const h = harness({
			directories: [LIVE, STOPPED].map((name) => `${WORK_ROOT}/${name}`),
			activeLeases: async () => [
				{
					id: LIVE.slice("hobo-".length),
					sandboxName: LIVE,
					jobId: "dispatching-job",
				},
				{
					id: STOPPED.slice("hobo-".length),
					sandboxName: STOPPED,
					jobId: "claiming-job",
				},
			],
		});

		await h.admission.reap();

		expect(h.retired).toEqual([]);
		expect(h.docker.containerExists).not.toHaveBeenCalled();
	});

	it("retires nothing when the fresh lease read fails", async () => {
		const log = vi.fn();
		const h = harness({
			directories: [`${WORK_ROOT}/${DEAD}`],
			activeLeases: async () => {
				throw new Error("store unavailable");
			},
			log,
		});

		await h.admission.reap();

		expect(h.retired).toEqual([]);
		expect(h.docker.containerExists).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith("hobo_ci_storage_prune_failed", {
			operation: "read-leases",
			message: "store unavailable",
		});
	});

	it("retires dead work directories on startup without running the full GC", async () => {
		const h = harness({ directories: [`${WORK_ROOT}/${DEAD}`] });
		await h.admission.reap();
		expect(h.retired).toEqual([`${WORK_ROOT}/.retired/${DEAD}-test`]);
		expect(h.fs.removeJobDirectory).not.toHaveBeenCalled();
		expect(h.scheduleRetiredSweep).toHaveBeenCalledOnce();
		expect(h.docker.pruneBuilder).not.toHaveBeenCalled();
		expect(h.docker.listImages).not.toHaveBeenCalled();
	});

	it("never prunes the pnpm store from admission, even with a reserve shortage", async () => {
		const h = harness({
			before: freeInodes(0),
			jobInodes: { workRoot: 200_000, dockerDataRoot: 170_000 },
		});

		await expect(h.admission.admit([], "job-1")).resolves.toBe(false);
		expect(h.pnpmStore.prune).not.toHaveBeenCalled();
	});

	it("prunes pnpm only for explicit idle GC maintenance", async () => {
		const pnpmStoreIdle = vi.fn(async () => true);
		const log = vi.fn();
		const h = harness({ pnpmStoreIdle, log });
		await h.admission.maintain([]);
		expect(h.pnpmStore.prune).not.toHaveBeenCalled();

		await h.admission.maintain(
			[{ id: LIVE.slice("hobo-".length), sandboxName: LIVE, jobId: "job-1" }],
			{ pnpmStore: true },
		);
		expect(h.pnpmStore.prune).not.toHaveBeenCalled();

		await h.admission.maintain([], { pnpmStore: true });
		expect(h.pnpmStore.prune).toHaveBeenCalledWith(pnpmStoreIdle);
		expect(log).toHaveBeenCalledWith("hobo_ci_pnpm_store_prune", {
			result: "pruned",
			ms: 1,
		});
	});

	it("defaults the pnpm idle check to busy", async () => {
		const prune = vi.fn<WorkerStoragePnpmStore["prune"]>(async (idle) => ({
			result: (await idle()) ? "pruned" : "busy",
			ms: 1,
		}));
		const h = harness({ prune });

		await h.admission.maintain([], { pnpmStore: true });
		await expect(prune.mock.results[0]?.value).resolves.toMatchObject({
			result: "busy",
		});
	});

	it("blocks admission and logs once while a pnpm prune is in flight", async () => {
		let finish: (() => void) | undefined;
		const prune = vi.fn<WorkerStoragePnpmStore["prune"]>(
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ result: "pruned", ms: 1 });
				}),
		);
		const log = vi.fn();
		const h = harness({ prune, pnpmStoreIdle: async () => true, log });
		const maintenance = h.admission.maintain([], { pnpmStore: true });
		await vi.waitFor(() => expect(prune).toHaveBeenCalledOnce());

		await expect(h.admission.admit([], "job-1")).resolves.toBe(false);
		await expect(h.admission.admit([], "job-1")).resolves.toBe(false);
		expect(
			log.mock.calls.filter(
				([event]) => event === "hobo_ci_storage_admission_wait",
			),
		).toEqual([
			[
				"hobo_ci_storage_admission_wait",
				{ message: "pnpm store prune in progress" },
			],
		]);
		finish?.();
		await maintenance;
	});

	it("collects deps images, builder cache and dangling images on maintenance", async () => {
		const h = harness({
			images: [
				{
					id: "fetch",
					tag: "hobo-ci-deps-fetch:old",
					created: "2026-01-01",
					inUse: false,
				},
				{
					id: "new",
					tag: "hobo-ci-deps:new",
					created: "2026-04-01",
					inUse: false,
				},
				{
					id: "middle",
					tag: "hobo-ci-deps:middle",
					created: "2026-03-01",
					inUse: false,
				},
				{
					id: "old",
					tag: "hobo-ci-deps:old",
					created: "2026-02-01",
					inUse: false,
				},
				{
					id: "worker-old",
					tag: "hobo-ci-worker:v000000000001",
					created: "2026-01-01",
					inUse: false,
				},
				{
					id: "worker-previous",
					tag: "hobo-ci-worker:v000000000002",
					created: "2026-02-01",
					inUse: false,
				},
				{
					id: "worker-current",
					tag: "hobo-ci-worker:v000000000003",
					created: "2026-03-01",
					inUse: false,
				},
				{
					id: "worker-current",
					tag: "hobo-ci-worker:local",
					created: "2026-03-01",
					inUse: false,
				},
			],
		});
		await h.admission.maintain([]);
		expect(h.docker.removeImage).toHaveBeenCalledWith("hobo-ci-deps-fetch:old");
		expect(h.docker.removeImage).toHaveBeenCalledWith("hobo-ci-deps:old");
		expect(h.docker.removeImage).toHaveBeenCalledWith(
			"hobo-ci-worker:v000000000001",
		);
		expect(h.docker.removeImage).not.toHaveBeenCalledWith(
			"hobo-ci-deps:middle",
		);
		expect(h.docker.pruneBuilder).toHaveBeenCalledWith("4GB");
		expect(h.docker.pruneDanglingImages).toHaveBeenCalledOnce();
	});
});
