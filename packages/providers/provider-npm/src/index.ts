export {
	NPM_CONFLICT_REASONS,
	NPM_OTP_REMEDIATION,
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	NPM_PROVIDER_ID,
	type NpmConflictReason,
	NpmOtpRequiredError,
	NpmVersionConflictError,
	npmProductRefusal,
} from "./errors.js";
export {
	type NpmProvenanceAttachment,
	parseProvenanceBundle,
} from "./provenance.js";
export {
	GITHUB_PACKAGES_NPM_ORIGIN,
	NPM_MAX_RESPONSE_BYTES,
	NPM_REGISTRY_KINDS,
	NPM_TIMEOUT_MS,
	NPMJS_REGISTRY_ORIGIN,
	type NpmRegistryBinding,
	type NpmRegistryKind,
	type NpmRegistryTarget,
	parseNpmRegistryBinding,
} from "./registry.js";
export {
	createNpmResolvers,
	NPM_AUTH_MODES,
	NPM_DEFAULT_DEPRECATION_MESSAGE,
	NPM_DIRECTIVES,
	type NpmArtifactBlobReader,
	type NpmAuthMode,
	type NpmResolverOptions,
	npmResolverRegistry,
} from "./resolver.js";
export {
	compareIntegrity,
	NPM_MAX_TARBALL_BYTES,
	type NpmTarball,
	parseNpmTarball,
} from "./tarball.js";
export {
	NPM_TRAFFIC_ROUTING_ABSENT,
	NPM_TRAFFIC_ROUTING_OFFERING_IDS,
	NPM_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_NPM_PACKAGE = "@hobo/provider-npm";
