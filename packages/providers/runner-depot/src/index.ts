export {
	BUILD_CACHE_HIT_OBSERVED,
	type CacheHitFact,
	createDepotBuildMachineProvider,
	DEPOT_CACHE_LANE,
	DEPOT_EXECUTOR_MISSING,
	type DepotBuildExecutor,
	type DepotBuildMachineProviderOptions,
	DepotExecutorMissingError,
} from "./build-machine-provider.js";
export {
	createDepotCatalogEntry,
	type DepotCatalogEntry,
} from "./catalog-entry.js";
export {
	type BrokeredDepotTokenProvider,
	createDepotClient,
	DEPOT_API_ERROR,
	DEPOT_CREDENTIALS_MISSING,
	DEPOT_PROJECT_TOKEN_REF,
	DepotApiError,
	type DepotBuildHandle,
	type DepotBuildStatus,
	type DepotClient,
	type DepotClientOptions,
	type DepotCredentialResolver,
	DepotCredentialsMissingError,
	type DepotFetch,
	type DepotFetchResponse,
	ownerDepotTokenProvider,
} from "./depot-client.js";
export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_FACTS,
	DEFAULT_REGIONS,
	DEPOT_DECLARED_CACHE_HIT_RATE,
	DEPOT_PROVIDER_ID,
	DEPOT_RUNS_ON_DEFAULT,
	type DepotManifestInput,
	executionHostManifest,
	MANIFEST_SCHEMA,
	type PublishedManifestDocuments,
	type PublishedManifestParseResult,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "./manifest.js";
export {
	createDepotRunnerProvider,
	DEPOT_RUNNER_WORKFLOW_DEFAULT,
	type DepotRunnerProviderOptions,
} from "./runner-provider.js";

export const HOBO_RUNNER_DEPOT_PACKAGE = "@hobo/runner-depot";
