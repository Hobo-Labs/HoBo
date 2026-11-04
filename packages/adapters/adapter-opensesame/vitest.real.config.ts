import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../../scripts/ci/vitest-max-workers.mts";

// The real lane: the real `opensesame`, the plugin's test build, a sealed
// store, a recording TLS upstream. It needs HOBO_OPENSESAME_KIT (see
// test/real/kit.ts) and fails, never skips, without it. One file at a time:
// every test builds a sandbox and starts processes.
export default defineConfig({
	test: {
		include: ["test/real/**/*.real.test.ts"],
		globalSetup: ["test/real/global-setup.ts"],
		testTimeout: 180_000,
		hookTimeout: 120_000,
		fileParallelism: false,
		maxWorkers: capVitestWorkers(1),
	},
});
