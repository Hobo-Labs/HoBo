import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
		maxWorkers: capVitestWorkers(undefined),
	},
});
