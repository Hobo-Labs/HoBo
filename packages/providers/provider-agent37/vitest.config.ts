import { mergeConfig } from "vitest/config";
import root from "../../../vitest.config.ts";

export default mergeConfig(root, {
	test: { exclude: ["**/*.deep.test.ts", "**/live-*.test.ts"] },
});
