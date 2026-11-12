import { defineConfig } from "vitest/config";

// The deep tier, `test:deep`: only `*.deep.test.ts`, whose sweeps and growth
// measurements take seconds each.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.deep.test.ts"],
		testTimeout: 600_000,
	},
});
