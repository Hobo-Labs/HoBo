import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.deep.test.ts"],
		testTimeout: 600_000,
	},
});
