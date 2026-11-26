import { mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// The repository's config; this package has no deep tier.
export default mergeConfig(root, {});
