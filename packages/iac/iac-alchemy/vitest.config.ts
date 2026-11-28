import { mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../../scripts/ci/vitest-max-workers.mts";
import root from "../../../vitest.config.ts";

export default mergeConfig(root, {
	test: { maxWorkers: capVitestWorkers(1) },
});
