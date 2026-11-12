import { mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// The repository's config; this package has no deep tier. The workerd suite
// starts one Miniflare per file, so files run one at a time.
export default mergeConfig(root, { test: { fileParallelism: false } });
