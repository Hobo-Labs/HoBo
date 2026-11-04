import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { chown, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WorkerImage } from "../src/isolated-worker/image-gc.js";
import {
	createNodeWorkerStorageFileSystem,
	createWorkerStorageAdmission,
	type WorkerFileSystemStats,
	type WorkerStorageDockerDriver,
	type WorkerStorageFileSystem,
	type WorkerStoragePnpmStore,
} from "../src/isolated-worker/storage-admission.js";

const nodeFs = {
	chown: vi.fn<typeof chown>(),
	mkdir: vi.fn<typeof mkdir>(),
};

const DOCKER_ROOT = "/var/lib/docker";
const WORK_ROOT = "/srv/hobo-ci/work";
const LIVE = "hobo-00000000-0000-4000-8000-000000000001";
const DEAD = "hobo-00000000-0000-4000-8000-000000000002";
const STOPPED = "hobo-00000000-0000-4000-8000-000000000003";

function usage(percent: number): WorkerFileSystemStats {
	return {
		blocks: 100,
		bfree: 100 - percent,
		files: 100,
		ffree: 100 - percent,
	};
}

function harness(
	input: {
		before?: WorkerFileSystemStats;
		after?: WorkerFileSystemStats;
		directories?: readonly string[];
		existingContainers?: ReadonlySet<string>;
		images?: readonly WorkerImage[];
		log?: ReturnType<typeof vi.fn>;
	} = {},
) {
	let current = input.before ?? usage(20);
	const removed: string[] = [];
	const fs: WorkerStorageFileSystem = {
		statfs: vi.fn(async () => current),
		jobDirectories: vi.fn(async () => input.directories ?? []),
		prepareJobDirectory: vi.fn(async () => undefined),
		removeJobDirectory: vi.fn(async (path: string) => {
			removed.push(path);
			return { bytes: 128, entries: 4 };
		}),
	};
	const docker: WorkerStorageDockerDriver = {
		dataRoot: vi.fn(async () => DOCKER_ROOT),
		pruneBuilder: vi.fn(async () => {
			current = input.after ?? current;
		}),
		containerExists: vi.fn(
			async (name: string) => input.existingContainers?.has(name) ?? false,
		),
		listImages: vi.fn(async () => input.images ?? []),
		removeImage: vi.fn(async () => undefined),
		pruneDanglingImages: vi.fn(async () => undefined),
	};
	const pnpmStore: WorkerStoragePnpmStore = {
		prune: vi.fn(async () => undefined),
	};
	const admission = createWorkerStorageAdmission({
		dockerDataRoot: DOCKER_ROOT,
		workRoot: WORK_ROOT,
		fs,
		docker,
		pnpmStore,
		log: input.log,
	});
	return { admission, docker, fs, pnpmStore, removed };
}

describe("worker storage admission", () => {
	it("prepares owned checkout directories inside each job mount", async () => {
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
	});

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

	it("does not prune below either 85 percent threshold", async () => {
		const h = harness({ before: usage(85) });
		await expect(h.admission.admit([])).resolves.toBe(true);
		expect(h.docker.pruneBuilder).not.toHaveBeenCalled();
		expect(h.fs.jobDirectories).not.toHaveBeenCalled();
	});

	it("prunes above threshold, samples both roots again, and admits below the hard limit", async () => {
		const h = harness({ before: usage(90), after: usage(80) });
		await expect(h.admission.admit([])).resolves.toBe(true);
		expect(h.docker.pruneBuilder).toHaveBeenCalledWith("4GB");
		expect(h.fs.statfs).toHaveBeenCalledTimes(4);
		expect(h.fs.statfs).toHaveBeenCalledWith(DOCKER_ROOT);
		expect(h.fs.statfs).toHaveBeenCalledWith(WORK_ROOT);
	});

	it("blocks still-high filesystems and logs one pressure event per episode", async () => {
		const log = vi.fn();
		const h = harness({ before: usage(96), after: usage(96), log });
		await expect(h.admission.admit([])).resolves.toBe(false);
		await expect(h.admission.admit([])).resolves.toBe(false);
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
		const h = harness({
			before: usage(90),
			after: usage(80),
			directories: [LIVE, DEAD, STOPPED].map((name) => `${WORK_ROOT}/${name}`),
			existingContainers: new Set([STOPPED]),
		});
		await expect(
			h.admission.admit([
				{
					id: LIVE.slice("hobo-".length),
					sandboxName: LIVE,
				},
			]),
		).resolves.toBe(true);
		expect(h.removed).toEqual([`${WORK_ROOT}/${DEAD}`]);
		expect(h.docker.containerExists).not.toHaveBeenCalledWith(LIVE);
		expect(h.docker.containerExists).toHaveBeenCalledWith(STOPPED);
	});

	it("reaps dead work directories on startup without running the full GC", async () => {
		const h = harness({ directories: [`${WORK_ROOT}/${DEAD}`] });
		await h.admission.reap([]);
		expect(h.removed).toEqual([`${WORK_ROOT}/${DEAD}`]);
		expect(h.docker.pruneBuilder).not.toHaveBeenCalled();
		expect(h.docker.listImages).not.toHaveBeenCalled();
	});

	it("skips pnpm store pruning while any job holds an install lease", async () => {
		const h = harness();
		await h.admission.maintain([
			{ id: LIVE.slice("hobo-".length), sandboxName: LIVE },
		]);
		expect(h.pnpmStore.prune).not.toHaveBeenCalled();
		await h.admission.maintain([]);
		expect(h.pnpmStore.prune).toHaveBeenCalledOnce();
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
