import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
		globalSetup: ["test/support/global-setup.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
	},
});
