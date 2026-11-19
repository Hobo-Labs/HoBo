import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";

const config = mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			maxWorkers: capVitestWorkers(process.env.CI ? 1 : undefined),
			isolate: false,
			server: { deps: { external: [/[/\\]node_modules[/\\]typescript[/\\]/] } },
		},
	}),
);

const rootGlobalSetup = [config.test?.globalSetup ?? []].flat();
config.test = {
	...config.test,
	globalSetup: [
		...rootGlobalSetup.filter(
			(setup) => !setup.endsWith("wasmtime-global-setup.ts"),
		),
		fileURLToPath(new URL("./test/support/run-scratch.ts", import.meta.url)),
	],
};

export default config;
