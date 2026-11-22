import { defineConfig, mergeConfig } from "vitest/config";
import { capVitestWorkers } from "../../scripts/ci/vitest-max-workers.mts";
import rootConfig from "../../vitest.config.js";
import { ISOLATED_TEST_FILES } from "./test/support/isolated-test-files.js";
import { RELEASE_INTEGRATION_TEST_FILES } from "./test/support/release-integration-test-files.js";

const releaseIntegration = new Set<string>(RELEASE_INTEGRATION_TEST_FILES);
const defaultIsolatedInclude = ISOLATED_TEST_FILES.filter(
	(file) => !releaseIntegration.has(file),
);

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
						include: defaultIsolatedInclude,
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
						exclude: [
							...new Set([
								...ISOLATED_TEST_FILES,
								...RELEASE_INTEGRATION_TEST_FILES,
							]),
						],
					},
				},
			],
		},
	}),
);
