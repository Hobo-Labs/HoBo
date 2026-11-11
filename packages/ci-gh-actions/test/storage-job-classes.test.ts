import { describe, expect, it } from "vitest";
import {
	STORAGE_CLASS_RESERVES,
	storageClassForJob,
	storageReserveForClass,
	storageReserveForJob,
} from "../src/isolated-worker/storage-job-classes.js";
import { learnedStorageReserve } from "../src/isolated-worker/storage-peaks.js";

describe("storage job classes", () => {
	it("maps release pages and OCI jobs to trunk budgets", () => {
		expect(storageClassForJob("Publish GitHub Pages (site/)")).toBe(
			"release_trunk",
		);
		expect(
			storageClassForJob("Build all OCI images on tag (gate publish)"),
		).toBe("runner_image");
		const pages = storageReserveForJob("Publish GitHub Pages (site/)");
		expect(pages.workRootBytes).toBeGreaterThanOrEqual(
			STORAGE_CLASS_RESERVES.heavy.workRootBytes,
		);
	});

	it("waits when learned peaks exceed free bytes", () => {
		const history = {
			workRootBytes: [14e9, 15e9, 16e9],
			workRootInodes: [180_000, 190_000, 200_000],
		};
		const reserve = learnedStorageReserve(
			history,
			storageReserveForClass("release_trunk"),
		);
		expect(reserve.workRootBytes).toBeLessThanOrEqual(
			STORAGE_CLASS_RESERVES.release_trunk.workRootBytes,
		);
		expect(reserve.workRootBytes).toBeGreaterThan(12e9);
	});
});
