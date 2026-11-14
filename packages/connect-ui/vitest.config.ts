import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// `*.deep.test.ts` is the deep tier (`test:deep`, vitest.deep.config.ts).
		exclude: [...configDefaults.exclude, "**/*.deep.test.ts"],
	},
});
