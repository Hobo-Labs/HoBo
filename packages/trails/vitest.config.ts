import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// The CI job's memory-derived cap (HOBO_TEST_MAX_WORKERS), as the root
		// config applies it; unset, Vitest's default.
		maxWorkers: capVitestWorkers(undefined),
	},
});
