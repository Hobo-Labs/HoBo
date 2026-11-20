import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";
import { RELEASE_INTEGRATION_TEST_FILES } from "./test/support/release-integration-test-files.js";

export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			fileParallelism: false,
			maxWorkers: capVitestWorkers(1),
			server: {
				deps: {
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
						name: "release-integration",
						isolate: true,
						include: [...RELEASE_INTEGRATION_TEST_FILES],
					},
				},
			],
		},
	}),
);
