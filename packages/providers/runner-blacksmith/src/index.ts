export {
	BLACKSMITH_BUILD_WORKFLOW_DEFAULT,
	BLACKSMITH_CACHE_LANE,
	type BlacksmithBuildMachineProviderOptions,
	BUILD_CACHE_LANE_OBSERVED,
	type CacheLaneFact,
	createBlacksmithBuildMachineProvider,
} from "./build-machine-provider.js";
export {
	type BlacksmithCatalogEntry,
	createBlacksmithCatalogEntry,
} from "./catalog-entry.js";
export {
	AUTH_SCHEMA,
	BLACKSMITH_PROVIDER_ID,
	BLACKSMITH_RUNS_ON_DEFAULT,
	type BlacksmithManifestInput,
	CAPABILITIES_SCHEMA,
	COST_FACTS,
	DEFAULT_REGIONS,
	executionHostManifest,
	MANIFEST_SCHEMA,
	type PublishedManifestDocuments,
	type PublishedManifestParseResult,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "./manifest.js";
export {
	BLACKSMITH_RUNNER_WORKFLOW_DEFAULT,
	type BlacksmithRunnerProviderOptions,
	createBlacksmithRunnerProvider,
} from "./runner-provider.js";

// public-contract: the package id consumers assert against.
export const HOBO_RUNNER_BLACKSMITH_PACKAGE = "@hobo/runner-blacksmith";
