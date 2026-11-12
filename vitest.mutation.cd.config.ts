/**
 * Vitest config for the CD mutation lane (`stryker.cd.conf.json`, plan 0024
 * WP20). Like `vitest.mutation.config.ts`, it skips the root config's wasmtime
 * global setup and its repo-wide include glob. It collects only the suites
 * that exercise the mutated modules: the @hobo/cd decision tests, the
 * resolver-component guards, and the CD conformance kit.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		isolate: false,
		pool: "threads",
		include: [
			"packages/cd/test/{placement,fanout,verification,reconcile,agent,freight}/**/*.test.ts",
			"packages/resolver-components/test/**/*.test.ts",
			"examples/cd-conformance-kit/test/**/*.test.ts",
		],
		exclude: ["**/node_modules/**", "**/dist/**", "**/*-load.test.ts"],
		testTimeout: 20_000,
		hookTimeout: 20_000,
		coverage: { enabled: false },
		reporters: ["dot"],
	},
});
