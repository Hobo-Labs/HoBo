/* oxlint-disable anti-slop/no-shape-in-symbol-names -- SAFETY: CampShape and campToShape are established public compatibility names. */
export {
	attachCampToYard,
	CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
	CAMP_MIGRATION_CODE,
	camp,
	campToShape,
	parseLegacyCampMappings,
	withResolvers,
} from "./camp.js";
export { providerSelection } from "./provider-selection.js";
export {
	type ResolvedEnv,
	resolveLocalBindings,
} from "./resolve-local-bindings.js";
export type { StandardCampsOptions } from "./standard-camps.js";
export { standardCamps } from "./standard-camps.js";
export {
	type Camp,
	type CampConfig,
	type CampShape,
	EMPTY_RESOLVER_CONFIG,
	type JsonValue,
	type PrimitiveResolverConfig,
	type ProviderSelection,
	type ResolverPin,
	type ResourceMappingRule,
	type ResourceSelector,
	TOPOLOGY_CONTRACT_VERSION,
} from "./types.js";

// public-contract: package identity for boundary contracts.
export const HOBO_CAMPS_PACKAGE = "@hobo/camps";
