import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";

/** Heavy subprocess + esbuild suites; bound compiler concurrency on shared runners. */
const config = mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			// CI runs one worker: the compiler-heavy files are bounded on a shared
			// runner box. Elsewhere files spread across the cores, still under the
			// memory-derived HOBO_TEST_MAX_WORKERS cap when it is set.
			maxWorkers: capVitestWorkers(process.env.CI ? 1 : undefined),
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

// The root's global setups, minus its wasmtime warm-up: that downloads a
// 40-60 MB runtime on a cold runner, and no test here runs wasmtime. A setup
// the root adds later still runs here. run-scratch removes the fixtures
// test/support/built-starter.ts shares across files.
const rootGlobalSetup = [config.test?.globalSetup ?? []].flat();
config.test = {
	...config.test,
	globalSetup: [
		...rootGlobalSetup.filter(
			(setup) => !setup.endsWith("wasmtime-global-setup.ts"),
		),
		fileURLToPath(new URL("./test/support/run-scratch.ts", import.meta.url)),
	],
};

export default config;
