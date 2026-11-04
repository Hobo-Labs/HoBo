import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";

export default defineConfig({
	test: {
		globalSetup: [
			fileURLToPath(
				new URL("../../test/setup/hobo-test-homes.ts", import.meta.url),
			),
		],
		setupFiles: [
			"test/isolate-git-env.ts",
			fileURLToPath(
				new URL("../../test/setup/isolate-hobo-home.ts", import.meta.url),
			),
		],
		// Optimizexp feature binding tests live under .optimizexp/ and run via root test:file
		exclude: ["**/node_modules/**", "**/dist/**", "**/.optimizexp/**"],
		// This suite drives real subprocesses — `git init`, commit, `worktree
		// add`/`remove`, spawned sidecars — so its wall time tracks how loaded
		// the machine is rather than how much work the test does. Vitest's
		// 5s default is not a budget these tests were ever written against:
		// `session-orchestrator.test.ts` alone spends ~8.6s in test bodies
		// unloaded, and "keeps checkpoint refs when worktree removal fails"
		// timed out at 10.4s under a 4-way `turbo run test` on a 4-core box
		// while passing in isolation. 20s is the subprocess allowance; a real
		// hang still fails, it just fails for being a hang.
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 20_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 20_000),
		maxWorkers: capVitestWorkers(undefined),
	},
});
