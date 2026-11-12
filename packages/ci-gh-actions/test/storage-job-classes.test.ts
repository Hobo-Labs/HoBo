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

	it("classes a matrix leg by its job's name", () => {
		expect(
			storageClassForJob("Publish GHCR images (tagged release) (hobo-cli)"),
		).toBe("release_trunk");
		expect(
			storageClassForJob(
				"Build all OCI images on tag (gate publish) (hobo-mcp)",
			),
		).toBe("runner_image");
		expect(storageClassForJob("Attest GHCR images (hobo-sdk)")).toBe("light");
		// A name that itself ends in parentheses still matches exactly.
		expect(storageClassForJob("Publish GitHub Pages (site/)")).toBe(
			"release_trunk",
		);
		expect(storageClassForJob("Unknown job (x)")).toBe("standard");
	});

	it("scales unmeasured inode budgets below class caps", () => {
		const reserve = learnedStorageReserve(
			undefined,
			storageReserveForClass("heavy"),
		);
		expect(reserve.workRoot).toBeLessThan(
			storageReserveForClass("heavy").workRoot,
		);
		expect(reserve.dockerDataRoot).toBeLessThan(
			storageReserveForClass("heavy").dockerDataRoot,
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
