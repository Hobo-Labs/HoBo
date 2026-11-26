import { mergeConfig } from "vitest/config";
import root from "../../../vitest.config.ts";

// The deep tier, `test:deep`: only `*.deep.test.ts`, whose sweeps and growth
// measurements take seconds each.
export default mergeConfig(root, {
	test: { include: ["**/*.deep.test.ts"], testTimeout: 600_000 },
});
