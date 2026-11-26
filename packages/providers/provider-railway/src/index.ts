export {
	type RailwayDeploymentIdentity,
	RailwayDeploymentIdentitySchema,
} from "./_generated/deployment_identity_pb.js";
export {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
	railwayNativePorts,
} from "./equivalence.js";
export { PROVIDER_TARGET, railway, type TypedOptionBlock } from "./options.js";
export {
	parseRailwayBindings,
	parseRailwayPort,
	parseRailwayResourceName,
	parseRailwayResourcePlan,
	RAILWAY_PORTS,
	RAILWAY_REJECTED_CODE,
	type RailwayBindings,
	type RailwayFeature,
	RailwayInputRejectedError,
	type RailwayPortKind,
	type RailwayResourceName,
	type RailwayResourcePlan,
	railwayPortOrUndefined,
} from "./parse.js";
export { createRailwayProvider } from "./provider.js";
export {
	createRailwayDeploymentClient,
	createRailwayResolvers,
	RAILWAY_GRAPHQL_ENDPOINT,
	RAILWAY_SERVICE_PRODUCT_ID,
	type RailwayResolverOptions,
	railwayResolverRegistry,
} from "./resolvers.js";
export {
	provisionTemporaryEnvironmentStation,
	type RailwayTemporaryStationRefusal,
	railwayTemporaryStationRefusal,
	supportsAnonymousTemporaryDeploy,
	TEMPORARY_PROVISION_UNAVAILABLE_CODE,
	TemporaryProvisionUnavailableError,
} from "./temporary-station.js";
export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	ResourcePlan,
} from "./types.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_RAILWAY_PACKAGE = "@hobo/provider-railway";
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
export { RAILWAY_HOST_FORMS } from "./host-forms.js";
export {
	RAILWAY_HOSTING_COVERAGE,
	RAILWAY_RESOLVED_PRODUCT_IDS,
	RAILWAY_UNRESOLVED_PRODUCTS,
	railwayProductRefusal,
} from "./hosting-coverage.js";
export {
	RAILWAY_TRAFFIC_ROUTING_ABSENT,
	RAILWAY_TRAFFIC_ROUTING_OFFERING_IDS,
	RAILWAY_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";
