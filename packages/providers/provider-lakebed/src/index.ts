export {
	createLakebedResolvers,
	LAKEBED_CAPSULE_PRODUCT_ID,
	type LakebedCapsuleRecord,
	type LakebedDeployHost,
	type LakebedResolverOptions,
	lakebedResolverRegistry,
} from "./capsule-resolver.js";
export {
	type AbsentTrafficOffering,
	defineHostingCoverage,
	HOSTING_COVERAGE_CONTRACT,
	type HostingCoverage,
	hostingProductRefusal,
	instrumentResolvers,
	PORTABLE_TRAFFIC_OFFERING_IDS,
	RESOLVER_DURATION_METRIC,
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
	type ResolverMetricSink,
	type ResolverTelemetryOptions,
	type UnresolvedHostingProduct,
} from "./delivery-coverage.js";
export {
	assertDriverProgram,
	DRIVER_PROGRAM_API_VERSION,
	DRIVER_PROGRAM_KIND,
	type DriverProgram,
	type DriverResource,
	LAKEBED_DRIVER,
} from "./driver-program.js";
export {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
	lakebedNativeFeaturesForPort,
	lakebedNativePorts,
} from "./equivalence.js";
export {
	LAKEBED_HOSTING_COVERAGE,
	LAKEBED_RESOLVED_PRODUCT_IDS,
	LAKEBED_UNRESOLVED_PRODUCTS,
	lakebedProductRefusal,
} from "./hosting-coverage.js";
export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_FACTS,
	COST_SCHEMA,
	DEFAULT_REGIONS,
	LAKEBED_PROVIDER_ID,
	type LakebedManifestInput,
	MANIFEST_SCHEMA,
	type PublishedManifestDocuments,
	type PublishedManifestParseResult,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "./manifest.js";
export {
	LAKEBED_PROVIDER_TARGET,
	lakebed,
	type TypedOptionBlock,
} from "./options.js";
export {
	createLakebedProvider,
	type LakebedProviderOptions,
} from "./provider.js";
export {
	isRealizablePort,
	mergeLakebedOptions,
	type RealizablePort,
	realizeResourcePlan,
	realizeResourcePlans,
	realizeTrafficRoutingPlan,
	resolveEquivalence,
} from "./realize.js";
export {
	createLakebedAnonymousCliTransport,
	LAKEBED_TEMPORARY_PROVIDER_ID,
	type LakebedAnonymousDeployResult,
	type LakebedAnonymousTransport,
	type LakebedTemporaryStationInput,
	materializeEnvironmentStationCapsule,
	parseLakebedDeployOutput,
	provisionTemporaryEnvironmentStation,
	supportsAnonymousTemporaryDeploy,
} from "./temporary-station.js";
export {
	LAKEBED_TRAFFIC_ROUTING_ABSENT,
	LAKEBED_TRAFFIC_ROUTING_OFFERING_IDS,
	LAKEBED_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";
export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	CostSignal,
	Match,
	Outputs,
	PortKind,
	PortRequest,
	ProviderClient,
	ResourcePlan,
} from "./types.js";

// public-contract: the package id consumers assert against.
export const HOBO_PROVIDER_LAKEBED_PACKAGE = "@hobo/provider-lakebed";
