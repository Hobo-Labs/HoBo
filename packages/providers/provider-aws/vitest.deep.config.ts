import { mergeConfig } from "vitest/config";
import root from "../../../vitest.config.ts";

export default mergeConfig(root, {
	test: { include: ["**/*.deep.test.ts"], testTimeout: 600_000 },
});
