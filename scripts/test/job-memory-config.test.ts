import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeJobMemoryConfig,
	computeTurboConcurrency,
	MAIN_WORKSPACE_MEMORY_FLOOR_MB,
} from "../../packages/ci-gh-actions/src/isolated-worker/job-memory-config.ts";

describe("job memory config turbo concurrency", () => {
	it("keeps one turbo slot without learned peaks at the standard floor", () => {
		const config = computeJobMemoryConfig({ limitMb: 4096, cpuCount: 8 });
		assert.equal(config.turboConcurrency, 1);
	});

	it("raises turbo on standard class when measured peaks leave headroom", () => {
		assert.equal(
			computeTurboConcurrency({
				limitMb: MAIN_WORKSPACE_MEMORY_FLOOR_MB,
				cpuCount: 8,
				vitestMaxWorkers: 1,
				heapMb: 1664,
				recentPeakMb: 2400,
			}),
			2,
		);
	});

	it("never exceeds four parallel turbo slots", () => {
		const config = computeJobMemoryConfig({
			limitMb: 16_384,
			cpuCount: 16,
			recentPeakMb: 2048,
		});
		assert.ok(config.turboConcurrency <= 4);
		assert.ok(config.turboConcurrency >= 2);
	});
});
