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

export default defineConfig({
	test: {
		environment: "node",
		// Native CLI startup shares CPU with other workspace suites in the final gate.
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		// A spy a test leaves behind is undone before the next one, which matters
		// once files share a worker.
		restoreMocks: true,
		// `include` stays per project: a top-level one would put every file in
		// both projects.
		projects: [
			{
				extends: true,
				test: { name: "isolated", isolate: true, include: ISOLATED },
			},
			{
				extends: true,
				test: {
					name: "shared",
					// Each file re-imported the @hobo/* graph (about 0.5 s apiece);
					// sharing the worker's module graph imports it once. The global
					// state tests touch (environment, timers, PATH) is restored in
					// their own `finally` blocks.
					isolate: false,
					include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
					exclude: ISOLATED,
				},
			},
		],
	},
});
