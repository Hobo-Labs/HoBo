export {
	type BetterAuthConfig,
	type BetterAuthConfigInput,
	parseBetterAuthConfig,
} from "./config.js";

export {
	AUTH_ADAPTER_HOSTINGS,
	type AuthAdapterDescriptor,
	type AuthAdapterHosting,
	assertBetterAuthRuntimeAvailable,
	BETTER_AUTH_DESCRIPTOR,
	BETTER_AUTH_REQUIRED_PORTS,
	BETTER_AUTH_RUNTIME_MODULE,
} from "./descriptor.js";

export {
	BETTER_AUTH_CONFIG_ERROR_CODES,
	BETTER_AUTH_CLAIMS_ERROR_CODES,
	type BetterAuthClaimsErrorCode,
	type BetterAuthConfigErrorCode,
	BetterAuthClaimsError,
	BetterAuthConfigError,
	BetterAuthRuntimeUnavailableError,
} from "./errors.js";

export {
	AUTH_ADAPTER_CONTRACT,
	BETTER_AUTH_ADAPTER_ID,
	BETTER_AUTH_CLAIMS_MAPPING_VERSION,
} from "./ids.js";

export {
	BETTER_AUTH_SECRET_REF_SCHEMES,
	type BetterAuthSecretRef,
	type BetterAuthSecretRefScheme,
	betterAuthSecretRefScheme,
	parseBetterAuthSecretRef,
} from "./secret-locator.js";