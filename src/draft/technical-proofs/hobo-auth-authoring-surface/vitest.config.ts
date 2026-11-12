import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../../../vitest.config.ts";
import { capVitestWorkers } from "../../../../scripts/ci/vitest-max-workers.mts";

/** `spawnSync(tsc)` for type fixtures; needs headroom under shard memory contention (Finding 140). */
const TYPECHECK_TIMEOUT_MS = 60_000;

export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			maxWorkers: capVitestWorkers(process.env.CI ? 1 : undefined),
			testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? TYPECHECK_TIMEOUT_MS),
			hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? TYPECHECK_TIMEOUT_MS),
		},
	}),
);
