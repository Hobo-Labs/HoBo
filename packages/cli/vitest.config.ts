import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";

/** Heavy subprocess + esbuild suites; default vitest parallelism OOMs hobo runners. */
export default defineConfig({
	test: {
		maxWorkers: capVitestWorkers(1),
	},
});
