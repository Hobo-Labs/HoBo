import { describe, expect, it, vi } from "vitest";
import { createRetiredWorkDirectorySweeper } from "../src/isolated-worker/retired-work-directory-sweeper.js";
import type { WorkerStorageFileSystem } from "../src/isolated-worker/storage-admission.js";

const WORK_ROOT = "/srv/hobo-ci/work";
const RETIRED = `${WORK_ROOT}/.retired/hobo-00000000-0000-4000-8000-000000000001-m1`;

function fileSystem(input: {
	retiredDirectories: WorkerStorageFileSystem["retiredDirectories"];
	removeJobDirectory: WorkerStorageFileSystem["removeJobDirectory"];
}): WorkerStorageFileSystem {
	return {
		statfs: vi.fn(async () => ({
			blocks: 100,
			bfree: 100,
			files: 100,
			ffree: 100,
		})),
		device: vi.fn(async () => 1),
		jobDirectories: vi.fn(async () => []),
		retiredDirectories: input.retiredDirectories,
		prepareJobDirectory: vi.fn(async () => undefined),
		retireJobDirectory: vi.fn(async () => undefined),
		removeJobDirectory: input.removeJobDirectory,
	};
}

describe("retired work directory sweeper", () => {
	it("is single-flight, coalesces triggers into one rerun, and logs removals", async () => {
		let releaseFirstList: (() => void) | undefined;
		const firstList = new Promise<void>((resolve) => {
			releaseFirstList = resolve;
		});
		const retiredDirectories = vi
			.fn<WorkerStorageFileSystem["retiredDirectories"]>()
			.mockImplementationOnce(() => firstList.then(() => [RETIRED]))
			.mockResolvedValue([]);
		const removeJobDirectory = vi.fn(async () => ({ bytes: 128, entries: 4 }));
		const log = vi.fn();
		const sweeper = createRetiredWorkDirectorySweeper({
			fs: fileSystem({ retiredDirectories, removeJobDirectory }),
			workRoot: WORK_ROOT,
			log,
		});

		sweeper.trigger();
		sweeper.trigger();
		sweeper.trigger();
		expect(retiredDirectories).toHaveBeenCalledOnce();
		releaseFirstList?.();
		await sweeper.drain();

		expect(retiredDirectories).toHaveBeenCalledTimes(2);
		expect(removeJobDirectory).toHaveBeenCalledOnce();
		expect(removeJobDirectory).toHaveBeenCalledWith(RETIRED);
		expect(log).toHaveBeenCalledWith("hobo_ci_work_dir_removed", {
			path: RETIRED,
			bytes: 128,
			entries: 4,
			ms: expect.any(Number),
		});
	});

	it("logs removal failures without throwing from trigger or drain", async () => {
		const log = vi.fn();
		const sweeper = createRetiredWorkDirectorySweeper({
			fs: fileSystem({
				retiredDirectories: vi.fn(async () => [RETIRED]),
				removeJobDirectory: vi.fn(async () => {
					throw new Error("disk busy");
				}),
			}),
			workRoot: WORK_ROOT,
			log,
		});

		expect(() => sweeper.trigger()).not.toThrow();
		await expect(sweeper.drain()).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith("hobo_ci_work_dir_remove_failed", {
			path: RETIRED,
			message: "disk busy",
		});
	});
});
