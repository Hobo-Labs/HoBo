import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		maxWorkers: capVitestWorkers(undefined),
	},
});
