import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.deep.test.ts"],
		testTimeout: 600_000,
	},
});
