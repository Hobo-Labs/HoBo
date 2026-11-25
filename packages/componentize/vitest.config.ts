import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		pool: "forks",
		testTimeout: 10_000,
		hookTimeout: 10_000,
		coverage: { enabled: false },
		reporters: ["dot"],
	},
});
