import { defineConfig } from "vitest/config";

// The live acceptance run: a real model, so it is never part of `test`.
export default defineConfig({
	test: {
		environment: "node",
		include: ["acceptance/**/*.live.test.ts"],
	},
});
