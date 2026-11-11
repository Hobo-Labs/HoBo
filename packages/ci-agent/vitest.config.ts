import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
		// The workspace tests run real git; it shares CPU with other suites in the final gate.
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 20_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 20_000),
	},
});
