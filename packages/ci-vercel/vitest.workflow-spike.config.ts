// SPIKE: Workflow SDK integration tests on the in-process Local World.
// Kept out of vitest.config.ts so the relay's own test lane is unchanged.
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, "node_modules", ".cache", "workflow-spike");

// zod skew: the generated bundles inline @workflow/core but leave `zod`
// external, and Node loads them natively, so `zod` resolves from the bundle's
// directory upward, reaching this package's zod (4.4.x). @workflow/core 5.2.3
// calls z.compile(), which needs its declared zod ~4.5.4, and every run fails
// with "z10.compile is not a function". Give the bundle directory its own
// node_modules/zod pointing at the SDK's copy. Production would have to align
// the package's zod instead (src/workflow-spike/README.md, "zod skew").
// pnpm layout: <store>/workflow/../@workflow/core; core's zod two levels up.
const sdk = realpathSync(join(here, "node_modules", "workflow"));
const core = realpathSync(join(sdk, "..", "@workflow", "core"));
const sdkZod = realpathSync(join(core, "..", "..", "zod"));
mkdirSync(join(cache, "node_modules"), { recursive: true });
rmSync(join(cache, "node_modules", "zod"), { force: true });
symlinkSync(sdkZod, join(cache, "node_modules", "zod"), "dir");

export default defineConfig({
	plugins: [
		workflow({ outDir: join(cache, "bundles"), dataDir: join(cache, "data") }),
	],
	test: {
		environment: "node",
		include: ["test/workflow-spike/**/*.spike.ts"],
		testTimeout: 60_000,
		fileParallelism: false,
	},
});
