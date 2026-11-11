import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Files that load Docker, Pact or Dagger tooling (directly or through a
// helper). They keep vitest's per-file module isolation: their native
// bindings and engine connections have not been run in a shared worker.
const ISOLATED = [
	"contracts/backend-swap.consumer.test.ts",
	"contracts/local-github.pact.test.ts",
	"contracts/local-runner.pact.test.ts",
	"test/ci-store-contract.test.ts",
	"test/pact-broker.test.ts",
];

const setup = (name: string) =>
	fileURLToPath(new URL(`./test/setup/${name}`, import.meta.url));

// What both projects run with. The projects do not `extends: true` the root,
// so the root's globalSetup runs once for the run, not once per project.
const common = {
	environment: "node",
	// Native CLI startup shares CPU with other workspace suites in the final gate.
	testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
	hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
	// A spy a test leaves behind is undone before the next one, which matters
	// once files share a worker.
	restoreMocks: true,
} as const;

export default defineConfig({
	test: {
		// Temporary files on tmpfs where there is room: every SQLite store the
		// tests open commits with an fsync (test/setup/tmpfs-tmpdir.ts).
		globalSetup: [setup("tmpfs-tmpdir.ts")],
		projects: [
			{
				test: { ...common, name: "isolated", isolate: true, include: ISOLATED },
			},
			{
				test: {
					...common,
					name: "shared",
					// Each file re-imported the @hobo/* graph (about 0.5 s apiece);
					// sharing the worker's module graph imports it once. The global
					// state tests touch (environment, timers, PATH) is restored in
					// their own `finally` blocks or test hooks, and a file that leaves
					// a timer, server or process running fails
					// (test/setup/no-leaked-handles.ts).
					isolate: false,
					include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
					exclude: ISOLATED,
					setupFiles: [setup("no-leaked-handles.ts")],
				},
			},
		],
	},
});
