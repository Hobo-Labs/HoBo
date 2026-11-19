export {
	attachCampToYard,
	CAMP_PROVIDER_SELECTION_FORBIDDEN,
	camp,
	campToContract,
	withResolvers,
} from "./camp.js";
export {
	type ResolvedEnv,
	resolveLocalBindings,
} from "./resolve-local-bindings.js";
export type { StandardCampsOptions } from "./standard-camps.js";
export { standardCamps } from "./standard-camps.js";
export {
	type Camp,
	type CampConfig,
	type CampContract,
	EMPTY_RESOLVER_CONFIG,
	type JsonValue,
	type PrimitiveResolverConfig,
	type ResolverPin,
	type ResourceMappingRule,
	type ResourceSelector,
	TOPOLOGY_CONTRACT_VERSION,
} from "./types.js";

export const HOBO_CAMPS_PACKAGE = "@hobo/camps";
