import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../vitest.config.js";

// PostgreSQL/TLS process acceptance has its own explicit integration lane.
export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			isolate: true,
			include: ["test/**/*.test.ts"],
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
		},
	}),
);
