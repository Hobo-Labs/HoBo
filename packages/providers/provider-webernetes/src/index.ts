export {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
	webernetesNativePorts,
} from "./equivalence.js";
export {
	PROVIDER_TARGET,
	type TypedOptionBlock,
	webernetes,
} from "./options.js";
export {
	parseWebernetesBindings,
	parseWebernetesLocalEndpoint,
	parseWebernetesPort,
	parseWebernetesResourceName,
	parseWebernetesResourcePlan,
	parseWebernetesStationDeployment,
	parseWebernetesStationId,
	WEBERNETES_PORTS,
	WEBERNETES_REJECTED_CODE,
	type WebernetesBindings,
	type WebernetesEndpointLocality,
	type WebernetesFeature,
	WebernetesInputRejectedError,
	type WebernetesLocalEndpoint,
	type WebernetesPortKind,
	type WebernetesResourceName,
	type WebernetesResourcePlan,
	type WebernetesStationDeployment,
	webernetesPortOrUndefined,
} from "./parse.js";
export { createWebernetesProvider } from "./provider.js";
export {
	type LocalTemporaryStationInput,
	type LocalTempTransport,
	provisionTemporaryEnvironmentStation,
	supportsAnonymousTemporaryDeploy,
} from "./temporary-station.js";
export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	ResourcePlan,
} from "./types.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_WEBERNETES_PACKAGE = "@hobo/provider-webernetes";
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
	WEBERNETES_HOSTING_COVERAGE,
	WEBERNETES_RESOLVED_PRODUCT_IDS,
	WEBERNETES_UNRESOLVED_PRODUCTS,
	webernetesProductRefusal,
} from "./hosting-coverage.js";
export {
	createWebernetesResolvers,
	WEBERNETES_POD_PRODUCT_ID,
	type WebernetesResolverOptions,
	type WebernetesStationHost,
	type WebernetesStationRecord,
	webernetesResolverRegistry,
} from "./pod-resolver.js";
export {
	WEBERNETES_TRAFFIC_ROUTING_ABSENT,
	WEBERNETES_TRAFFIC_ROUTING_OFFERING_IDS,
	WEBERNETES_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";
