import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "node",
		globalSetup: ["test/support/postgres-global-setup.ts"],
		include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
	},
});
