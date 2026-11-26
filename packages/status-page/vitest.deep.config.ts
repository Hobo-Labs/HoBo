import { defineConfig } from "vitest/config";

// The deep tier, `test:deep`: only `*.deep.test.ts`, whose sweeps, growth
// measurements and full-size differentials take seconds each.
export default defineConfig({
	test: {
		include: ["test/**/*.deep.test.ts"],
		testTimeout: 600_000,
	},
});
