import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../vitest.config.js";
import { ISOLATED_TEST_FILES } from "./test/support/isolated-test-files.js";

// PostgreSQL/TLS process acceptance has its own explicit integration lane.
export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			exclude: ["e2e/**"],
			// One worker per CPU, each with the CI 3GB heap, outgrows a shared runner
			// box and the kernel OOM-kills the run (exit 137). Cap it in CI; the
			// HOBO_TEST_MAX_WORKERS override matches packages/code.
			maxWorkers:
				process.env.HOBO_TEST_MAX_WORKERS !== undefined
					? Number(process.env.HOBO_TEST_MAX_WORKERS)
					: process.env.CI
						? 2
						: undefined,
			// `include` stays per project: mergeConfig concatenates arrays, so a
			// top-level include would put every file in both projects.
			projects: [
				{
					extends: true,
					test: {
						name: "isolated",
						isolate: true,
						include: ISOLATED_TEST_FILES,
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
