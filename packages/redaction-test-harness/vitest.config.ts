import { mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// The fast tier, which `test` runs on every change: the repository's config
// without `*.deep.test.ts`. Sweeps, growth measurements and full-size
// differentials run in `test:deep` (vitest.deep.config.ts).
export default mergeConfig(root, {
	test: { exclude: ["**/*.deep.test.ts"] },
});
