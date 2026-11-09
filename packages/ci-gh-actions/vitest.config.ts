import { configDefaults, defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
		// `*.deep.test.ts` is the deep tier (`test:deep`, vitest.deep.config.ts).
		exclude: [...configDefaults.exclude, "**/*.deep.test.ts"],
		// Native CLI startup shares CPU with other workspace suites in the final gate.
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
	},
});
