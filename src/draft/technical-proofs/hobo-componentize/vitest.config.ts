import { defineConfig } from "vitest/config";
import { capVitestWorkers } from "../../../../scripts/ci/vitest-max-workers.mts";

export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: capVitestWorkers(1),
  },
});
