import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";

export default defineConfig({
	test: {
		// Forks, not threads: test/isolate-user-home.ts moves HOME, and
		// os.homedir() reads the process's C environment, which a worker
		// thread's process.env never reaches. In a thread, code that falls back
		// to os.homedir() would still find the developer's real home.
		pool: "forks",
		// One root of throwaway homes per run (the root's hobo-test-homes.ts),
		// and a guard that fails the run when a real HoBo home changed during
		// it (test/real-home-guard.ts).
		globalSetup: [
			fileURLToPath(
				new URL("../../test/setup/hobo-test-homes.ts", import.meta.url),
			),
			"test/real-home-guard.ts",
		],
		// Each file gets its own HOBO_HOME and each worker its own HOME inside
		// that root, so a call that omits its home cannot reach ~/.hobo.
		setupFiles: [
			"test/isolate-git-env.ts",
			fileURLToPath(
				new URL("../../test/setup/isolate-hobo-home.ts", import.meta.url),
			),
			"test/isolate-user-home.ts",
			"test/subprocess-teardown.ts",
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
		// while passing in isolation. release-code targets ~2 minutes wall time;
		// cap each test/hook at 2 minutes so a stuck PTY or sidecar cannot hold
		// the runner for 14+ minutes (override with HOBO_TEST_TIMEOUT).
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 120_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 120_000),
		maxWorkers: capVitestWorkers(undefined),
	},
});
