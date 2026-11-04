import { describe, expect, it, vi } from "vitest";
import type { WorkerImage } from "../src/isolated-worker/image-gc.js";
import {
	createWorkerStorageAdmission,
	type WorkerFileSystemStats,
	type WorkerStorageDockerDriver,
	type WorkerStorageFileSystem,
	type WorkerStoragePnpmStore,
} from "../src/isolated-worker/storage-admission.js";

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
	it("does not prune below either 85 percent threshold", async () => {
		const h = harness({ before: usage(85) });
		await expect(h.admission.admit([])).resolves.toBe(true);
		expect(h.docker.pruneBuilder).not.toHaveBeenCalled();
		expect(h.fs.jobDirectories).not.toHaveBeenCalled();
	});

	it("prunes above threshold, samples both roots again, and admits below the hard limit", async () => {
		const h = harness({ before: usage(90), after: usage(80) });
		await expect(h.admission.admit([])).resolves.toBe(true);
		expect(h.docker.pruneBuilder).toHaveBeenCalledWith("24h", "10GB");
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
				{ tag: "hobo-ci-deps-fetch:old", created: "2026-01-01", inUse: false },
				{ tag: "hobo-ci-deps:new", created: "2026-04-01", inUse: false },
				{ tag: "hobo-ci-deps:middle", created: "2026-03-01", inUse: false },
				{ tag: "hobo-ci-deps:old", created: "2026-02-01", inUse: false },
			],
		});
		await h.admission.maintain([]);
		expect(h.docker.removeImage).toHaveBeenCalledWith("hobo-ci-deps-fetch:old");
		expect(h.docker.removeImage).toHaveBeenCalledWith("hobo-ci-deps:old");
		expect(h.docker.removeImage).not.toHaveBeenCalledWith(
			"hobo-ci-deps:middle",
		);
		expect(h.docker.pruneBuilder).toHaveBeenCalledWith("24h", "10GB");
		expect(h.docker.pruneDanglingImages).toHaveBeenCalledOnce();
	});
});
