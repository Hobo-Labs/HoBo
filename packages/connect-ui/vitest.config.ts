import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
		exclude: [...configDefaults.exclude, "**/*.deep.test.ts"],
	},
});
