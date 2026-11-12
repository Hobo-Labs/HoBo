import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";
import { ISOLATED_TEST_FILES } from "./test/support/isolated-test-files.js";

// PostgreSQL/TLS process acceptance has its own explicit integration lane.
export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			// Native compiler and process acceptance must fit a bounded runner.
			fileParallelism: false,
			exclude: ["e2e/**"],
			// `fileParallelism: false` already makes Vitest run one worker, whatever
			// `maxWorkers` says. Say one here as well, through the cap, so the config
			// does not claim a worker count it never gets (it used to read "2 in
			// CI") and the memory-derived HOBO_TEST_MAX_WORKERS cannot raise it.
			maxWorkers: capVitestWorkers(1),
			// Each concurrent case in the four `describe.concurrent` suites spawns a
			// CLI child of ~450 MB (tsx from source, `codegen`, a served `up`). At the
			// default of 5 per worker, two workers held ~14 of them and the run peaked
			// at ~5.9 GB, past a 6 GiB job container (exit 137). Two per worker peaks
			// at ~3.6 GB in the same wall time: the cases wait on the CLI, not the CPU.
			maxConcurrency: 2,
			server: {
				deps: {
					// Load built workspace exports natively instead of re-transforming the
					// dependency graph. The CLI stays inline: its dynamic bindle imports
					// need Vite to resolve .js specifiers in TypeScript sources.
					external: [
						/\/packages\/(?!cli\/).*\/dist\//u,
						/[/\\]node_modules[/\\]typescript[/\\]/,
					],
				},
			},
			// `include` stays per project: mergeConfig concatenates arrays, so a
			// top-level include would put every file in both projects.
			projects: [
				{
					extends: true,
					test: {
						name: "isolated",
						isolate: true,
						include: ISOLATED_TEST_FILES,
						// The compile-time tests run under tsc in this project only
						// (in both, they would be type-checked twice), with the
						// tsconfig that includes them (src's tsconfig leaves test/
						// out), so `pnpm test` fails on one that does not compile.
						// That tsconfig also takes the Vercel deploy path's test
						// files, which compile cleanly, so a type error in one of them
						// fails the run as a source error; test/ as a whole does not.
						typecheck: {
							enabled: true,
							include: ["test/**/*.test-d.ts"],
							tsconfig: "./tsconfig.types.json",
						},
					},
				},
				{
					extends: true,
					test: {
						name: "shared",
						isolate: false,
						include: ["test/**/*.test.ts"],
						exclude: ISOLATED_TEST_FILES,
					},
				},
			],
		},
	}),
);
