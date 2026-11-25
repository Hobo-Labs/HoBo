import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// componentize-js (real D13 lane) spawns child processes wired to
		// process stdio; vitest worker-thread pools replace process.stdout with a
		// WritableWorkerStdio that child_process.spawn rejects. Forked processes
		// keep real fds (same reason the HOBO-603 spike ran with --pool=forks).
		pool: "forks",
		testTimeout: 10_000,
		hookTimeout: 10_000,
		coverage: { enabled: false },
		reporters: ["dot"],
	},
});
