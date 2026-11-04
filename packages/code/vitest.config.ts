import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["test/isolate-git-env.ts", "test/subprocess-teardown.ts"],
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
		maxWorkers:
			process.env.HOBO_TEST_MAX_WORKERS === undefined
				? undefined
				: Number(process.env.HOBO_TEST_MAX_WORKERS),
	},
});
