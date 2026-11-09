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
			// Files share a worker's module graph (the root default). Each file
			// re-importing `src/index`, every `@hobo/*` dependency and the compiler
			// cost ~54 CPU s of the ~63 s the light files took. Nothing here keeps
			// state across files: env changes are restored in `finally`/`afterEach`,
			// and the trainable registry is reset after each test that uses it.
			isolate: false,
			// Load the shipped compiler through Node, matching the product CLI.
			server: { deps: { external: [/[/\\]node_modules[/\\]typescript[/\\]/] } },
		},
	}),
);
