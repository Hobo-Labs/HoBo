import { mergeConfig } from "vitest/config";
import root from "../../../vitest.config.ts";

export default mergeConfig(root, {
	test: { exclude: ["**/live-*.test.ts"] },
});
