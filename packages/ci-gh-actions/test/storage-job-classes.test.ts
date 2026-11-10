import { describe, expect, it } from "vitest";
import {
	STORAGE_CLASS_RESERVES,
	storageClassForJob,
	storageReserveForJob,
} from "../src/isolated-worker/storage-job-classes.js";

describe("storage job classes", () => {
	it("maps fabric jobs to measured inode reserves", () => {
		expect(storageReserveForJob("Main full gate")).toEqual(
			STORAGE_CLASS_RESERVES.heavy,
		);
		expect(storageReserveForJob("unknown job")).toEqual(
			STORAGE_CLASS_RESERVES.standard,
		);
		expect(storageClassForJob("Publish local deps image (non-blocking)")).toBe(
			"deps_build",
		);
		expect(STORAGE_CLASS_RESERVES.standard.workRoot).toBe(180_000);
		expect(STORAGE_CLASS_RESERVES.deps_build.dockerDataRoot).toBe(420_000);
	});
});
