import { defineConfig } from "vitest/config";

/** Heavy subprocess + esbuild suites; default vitest parallelism OOMs hobo runners. */
export default defineConfig({
	test: {
		maxWorkers: 1,
	},
});
