import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		include: ["test/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/*.deep.test.ts"],
	},
});
