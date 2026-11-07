export {
	type NetlifyAnonymousHealthObservation,
	observeNetlifyAnonymousSite,
} from "./anonymous-health.js";
export {
	type AnonymousAuthorityProbe,
	type AnonymousSiteDriver,
	type AnonymousSiteDriverOptions,
	type AnonymousSiteRecord,
	anonymousSiteClaimCommands,
	assertClaimSettled,
	createNetlifyAnonymousSiteDriver,
	type DeployInput,
	isClaimError,
	type OwnershipSignal,
	type SiteOwnershipVerification,
} from "./anonymous-site.js";
export {
	type AnonymousClaimPlan,
	type AnonymousClaimPlanInput,
	anonymousBootstrapCommands,
	compileAnonymousClaimPlan,
	NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF,
	NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,
	NETLIFY_PROVIDER_ID,
	NETLIFY_SITE_VERIFICATION_REF,
	siteClaimItemId,
} from "./claim-plan.js";
export {
	createInMemoryIdempotencyStore,
	createNetlifyClient,
	type IdempotencyRecord,
	type IdempotencyState,
	type IdempotencyStore,
	NETLIFY_API_BASE,
	type NetlifyClient,
	type NetlifyClientOptions,
	type NetlifySite,
	type SiteAccess,
} from "./client.js";
export {
	depositSecret,
	resolveSecret,
	type SecretCustodyPort,
	type SecretCustodyScope,
	type SecretPurpose,
	type SecretResolverPort,
} from "./custody.js";
export {
	createNetlifyAnonymousStaticSiteDefinition,
	createNetlifyAuthenticatedSiteDefinition,
	createNetlifyStaticDeployDefinition,
	NETLIFY_ANONYMOUS_STATIC_SITE_CANDIDATE,
	NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
	NETLIFY_AUTHENTICATED_SITE_CANDIDATE,
	NETLIFY_AUTHENTICATED_SITE_DEFINITION_ID,
	NETLIFY_CANDIDATES,
	NETLIFY_DEFINITIONS,
	NETLIFY_EVIDENCE_CHECKED_AT,
	NETLIFY_SOURCE_REFS,
	type NetlifyDefinitionOverrides,
} from "./definitions.js";
export {
	type AnonymousDeployObservation,
	assertClaimActionIsNetlify,
	type DeployCommandResult,
	type ExpirySource,
	NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
	parseAnonymousDeployOutput,
} from "./deploy-output.js";
export {
	EQUIVALENCE_CLASSES,
	equivalenceForPort,
	INITIAL_CAPABILITY_PORTS,
	type InitialCapabilityPort,
	netlifyNativePorts,
} from "./equivalence.js";
export { netlify, PROVIDER_TARGET, type TypedOptionBlock } from "./options.js";
export {
	ANONYMOUS_ENV_ALLOWLIST,
	type AnonymousDeployArgvInput,
	anonymousDeployEnv,
	assertInertArgument,
	buildAnonymousDeployArgv,
	createNodeProcessRunner,
	NETLIFY_CLI_PACKAGE,
	NETLIFY_CLI_PACKAGE_SPEC,
	NETLIFY_CLI_VERSION,
	PERMANENT_CREDENTIAL_ENV_KEYS,
	type ProcessResult,
	type ProcessRunner,
	type ProcessRunOptions,
} from "./process-runner.js";
export { createNetlifyProvider } from "./provider.js";
export {
	isNetlifyProviderError,
	NetlifyProviderError,
	PROVIDER_ERROR_CODES,
	type ProviderErrorCode,
	type ProviderErrorDetail,
	type ProviderErrorOptions,
	type ProviderStatusContext,
	providerErrorForStatus,
	redactProviderText,
} from "./provider-errors.js";
export {
	type AnonymousSiteReceipt,
	assertNoCredentialMaterial,
	type CredentialScanHit,
	scanForCredentialMaterial,
	toAnonymousSiteReceipt,
} from "./receipt.js";
export {
	NETLIFY_RESOLVED_PRODUCT_IDS,
	NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
	type NetlifyResolverOptions,
	netlifyResolverRegistry,
	netlifyResolvers,
} from "./resolvers.js";
export {
	type CredentialContinuityGrade,
	type PlacementConstraint,
	type ProviderResourceDefinitionData,
	type ProviderSourceRef,
	RESOURCE_DEFINITION_VNEXT_SCHEMA,
	type RemediationHint,
	type ResourceDefinitionSemanticsData,
	semanticsToSelectionCandidate,
} from "./resource-definition.js";
export {
	NETLIFY_DEFAULT_BINDINGS,
	NETLIFY_STATIC_DEPLOY_PROFILE,
	type NetlifyStaticDeploySlotOptions,
	netlifySlots,
	staticDeployment,
} from "./slots.js";
export type {
	NetlifyAnonymousDeployResult,
	NetlifyAnonymousTransport,
	NetlifyDropFile,
	NetlifyTemporaryStationInput,
} from "./temporary-station.js";
export {
	createNetlifyAnonymousCliTransport,
	materializeNetlifyStation,
	NETLIFY_DROP_URL,
	NETLIFY_TEMPORARY_PROVIDER_ID,
	parseNetlifyAnonymousDeployOutput,
	provisionTemporaryEnvironmentStation,
	supportsAnonymousTemporaryDeploy,
} from "./temporary-station.js";
export {
	assertAllowedEndpoint,
	createFetchTransport,
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	NETLIFY_ALLOWED_PATH_PREFIXES,
	NETLIFY_API_ALLOWED_HOSTS,
	NETLIFY_CLAIM_HOST,
	type NetlifyTransport,
	type TransportMethod,
	type TransportPolicy,
	type TransportRequest,
	type TransportResponse,
} from "./transport.js";
export type {
	Capability,
	CapabilityManifest,
	CloudProvider,
	ResourcePlan,
} from "./types.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_NETLIFY_PACKAGE = "@hobo/provider-netlify";
