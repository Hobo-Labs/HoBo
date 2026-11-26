import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";

export default defineConfig({
	test: {
		include: ["e2e/ci.test.ts"],
		testTimeout: 30000,
		hookTimeout: 60000,
		fileParallelism: false,
		maxWorkers: capVitestWorkers(1),
	},
});
