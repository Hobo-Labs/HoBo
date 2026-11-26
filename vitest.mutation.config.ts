/**
 * Vitest config for the mutation lane (`stryker.scripts.conf.json`).
 *
 * Separate from `vitest.config.ts` for two reasons, both of which broke the
 * initial dry run:
 *
 *  - the root config's `globalSetup` warms the wasmtime toolchain from
 *    `packages/runtimes/`, which the mutation sandbox deliberately excludes;
 *  - the root config's include glob is repo-wide, so it collects thousands of
 *    package tests that have nothing to do with the file under mutation and
 *    are not copied into the sandbox either.
 *
 * Scoped to the suites that actually exercise the checker, which is also what
 * makes the lane fast enough that someone will run it.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		isolate: false,
		pool: "threads",
		include: ["test/competitor-docs*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
		testTimeout: 20_000,
		hookTimeout: 20_000,
		coverage: { enabled: false },
		reporters: ["dot"],
	},
});
