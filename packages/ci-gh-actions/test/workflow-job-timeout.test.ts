import { describe, expect, it } from "vitest";
import { MAX_ISOLATED_JOB_TIMEOUT_MS } from "../src/isolated-worker/container-timeout.js";
import {
	effectiveIsolatedTimeoutMs,
	workflowJobTimeoutMinutes,
} from "../src/isolated-worker/workflow-job-timeout.js";

describe("workflowJobTimeoutMinutes", () => {
	it("maps main workspace shards to twenty minutes", () => {
		expect(workflowJobTimeoutMinutes("Main workspace test shard 3")).toBe(20);
	});
});

describe("effectiveIsolatedTimeoutMs", () => {
	it("raises routing budget when workflow timeout is longer", () => {
		expect(
			effectiveIsolatedTimeoutMs(10, "Main workspace test shard 3"),
		).toBe(20 * 60_000);
	});

	it("keeps reserved minutes when no workflow mapping exists", () => {
		expect(effectiveIsolatedTimeoutMs(10, "Route runners")).toBe(10 * 60_000);
	});

	it("still caps at the isolated twenty-minute ceiling", () => {
		expect(effectiveIsolatedTimeoutMs(30, "Main full gate")).toBe(
			MAX_ISOLATED_JOB_TIMEOUT_MS,
		);
	});
});
