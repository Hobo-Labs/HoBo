import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";
import { ISOLATED_TEST_FILES } from "./test/support/isolated-test-files.js";

export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			fileParallelism: false,
			exclude: ["e2e/**"],
			maxWorkers: capVitestWorkers(1),
			maxConcurrency: 2,
			server: {
				deps: {
					// need Vite to resolve .js specifiers in TypeScript sources.
					external: [
						/\/packages\/(?!cli\/).*\/dist\//u,
						/[/\\]node_modules[/\\]typescript[/\\]/,
					],
				},
			},
			projects: [
				{
					extends: true,
					test: {
						name: "isolated",
						isolate: true,
						include: ISOLATED_TEST_FILES,
						typecheck: {
							enabled: true,
							include: ["test/**/*.test-d.ts"],
							tsconfig: "./tsconfig.types.json",
						},
					},
				},
				{
					extends: true,
					test: {
						name: "shared",
						isolate: false,
						include: ["test/**/*.test.ts"],
						exclude: ISOLATED_TEST_FILES,
					},
				},
			],
		},
	}),
);
