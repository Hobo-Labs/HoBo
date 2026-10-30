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
