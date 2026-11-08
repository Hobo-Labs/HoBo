import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";

/** Heavy subprocess + esbuild suites; bound compiler concurrency on shared runners. */
export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			maxWorkers: capVitestWorkers(1),
			fileParallelism: false,
			// Preserve the package's default per-file isolation when inheriting root setup.
			isolate: true,
			// Load the shipped compiler through Node, matching the product CLI.
			server: { deps: { external: [/[/\\]node_modules[/\\]typescript[/\\]/] } },
		},
	}),
);
