export {
	BETTER_AUTH_ACCEPTED_CLAIM_KEYS,
	BETTER_AUTH_UNMAPPED_CLAIM_KEYS,
	type BetterAuthClaimKey,
	type MappedPrincipal,
	mapClaimsToPrincipal,
} from "./claims.js";

export {
	BETTER_AUTH_CLAIMS_CONFORMANCE_CASES,
	type ClaimsMappingCase,
	type ClaimsMappingConformanceResult,
	type ClaimsMappingExpectation,
	runClaimsMappingConformance,
	unexercisedAcceptedClaimKeys,
} from "./claims-conformance.js";

export {
	type BetterAuthConfig,
	type BetterAuthConfigInput,
	parseBetterAuthConfig,
} from "@hobo/auth-adapter-contract";

export {
	AUTH_ADAPTER_HOSTINGS,
	type AuthAdapterDescriptor,
	type AuthAdapterHosting,
	assertBetterAuthRuntimeAvailable,
	BETTER_AUTH_DESCRIPTOR,
	BETTER_AUTH_REQUIRED_PORTS,
	BETTER_AUTH_RUNTIME_MODULE,
} from "@hobo/auth-adapter-contract";

export {
	BETTER_AUTH_CLAIMS_ERROR_CODES,
	BETTER_AUTH_CONFIG_ERROR_CODES,
	BetterAuthClaimsError,
	type BetterAuthClaimsErrorCode,
	BetterAuthConfigError,
	type BetterAuthConfigErrorCode,
	BetterAuthRuntimeUnavailableError,
} from "@hobo/auth-adapter-contract";

export {
	AUTH_ADAPTER_CONTRACT,
	BETTER_AUTH_ADAPTER_ID,
	BETTER_AUTH_CLAIMS_MAPPING_VERSION,
} from "@hobo/auth-adapter-contract";

export {
	BETTER_AUTH_SECRET_REF_SCHEMES,
	type BetterAuthSecretRef,
	type BetterAuthSecretRefScheme,
	betterAuthSecretRefScheme,
	parseBetterAuthSecretRef,
} from "@hobo/auth-adapter-contract";