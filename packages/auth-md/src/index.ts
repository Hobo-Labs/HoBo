/**
 * `@hobo/auth-md` — the auth.md agent-principal / delegated-authorization
 * plane. auth.md is agent identity, not infrastructure ownership; see
 * README.md for the three independent state machines this package keeps
 * separate.
 */

export type {
	RevokedAgentPrincipalRecord,
	StoredCliAuthMdClaimInitiationRecord,
	StoredCliAuthMdStateRecord,
} from "./_generated/auth_md_pb.js";
export {
	type AssertionExpectation,
	type AssertionVerifier,
	type AssertionVerifierResult,
	createFixtureAssertion,
	createFixtureAssertionVerifier,
	type FixtureAssertionClaims,
	type VerifiedAssertion,
	verifyIdentityAssertion,
} from "./assertion.js";
export {
	type AgentPrincipalClaimRef,
	assertBindingMatches,
	type ClaimedAgentPrincipal,
	type ClaimInitiation,
	type ClaimPollResult,
	type HumanAuthorization,
	type InitiateHumanClaimOptions,
	initiateHumanClaim,
	type PollHumanClaimOptions,
	pollHumanClaim,
	preClaimAgentPrincipalClaimRef,
	type ResolveClaimScopesInput,
	resolveClaimScopes,
	toAgentPrincipalClaimRef,
} from "./claim.js";
export {
	AUTH_MD_PATH,
	type AuthMdDiscovery,
	type AuthMdDocument,
	authMdDocumentUrl,
	type DiscoveryOptions,
	discoverAuthMd,
	type MetadataProseConflict,
	PROTECTED_RESOURCE_METADATA_PATH,
	type ProtectedResourceMetadata,
	parseAuthMdDocument,
	parseProtectedResourceMetadata,
	protectedResourceMetadataUrl,
	reconcileDiscovery,
} from "./discovery.js";
export {
	AUTHMD_ERROR_CODES,
	AuthMdError,
	type AuthMdErrorCode,
	type AuthMdErrorJson,
	authMdError,
	isAuthMdError,
	isAuthMdErrorCode,
} from "./errors.js";
export {
	type AgentPrincipalEvent,
	type AgentPrincipalEventType,
	type AgentPrincipalView,
	AUTHMD_EVENT_TYPES,
	agentRegisteredEvent,
	claimInitiatedEvent,
	credentialsRotatedEvent,
	EMPTY_AGENT_PRINCIPAL_VIEW,
	foldAgentPrincipalEvents,
	principalClaimedEvent,
	principalRevokedEvent,
	scopeWideningDeniedEvent,
} from "./events.js";
export {
	DEFAULT_MAX_RESPONSE_BYTES,
	DEFAULT_TIMEOUT_MS,
	type HttpPort,
	type HttpRequestOptions,
	type HttpResponseView,
	MAX_SAME_HOST_REDIRECTS,
	requestBounded,
	requestJson,
} from "./http.js";
export {
	createSensitive,
	discloseSensitive,
	forgetSensitive,
	formatRedacted,
	isMaterialLocator,
	isSensitiveRef,
	type MaterialLocator,
	materialLocator,
	REDACTED,
	redactDeep,
	redactText,
	type SensitiveKind,
	type SensitiveRef,
} from "./redaction.js";
export {
	type AgentRegistration,
	materialHandle,
	type RegisterAnonymousAgentOptions,
	registerAnonymousAgent,
} from "./registration.js";
export {
	type AgentPrincipal,
	assertManagementAccess,
	type KeyRotation,
	type RevokedAgentPrincipal,
	type RotationOutcome,
	type RotationPort,
	type RotationReason,
	requiresRotation,
	reRegisterAfterRevocation,
	revokeAgentPrincipal,
	rotateAgentCredentials,
} from "./rotation.js";
export {
	type AgentPrincipalCommand,
	type AgentPrincipalPhase,
	advanceAgentPrincipal,
	advanceHumanSession,
	advanceInfrastructure,
	type HumanSessionCommand,
	type HumanSessionPhase,
	type InfrastructureCommand,
	type InfrastructurePhase,
	isWorkClaimedByHumanWithRevokedAgent,
	type PlaneSnapshot,
	planeSnapshot,
} from "./state-machines.js";
export {
	type AgentAccessToken,
	discoverAgentTokenEndpoint,
	exchangeAgentAccessToken,
} from "./token-exchange.js";
export {
	type Audience,
	type HttpsUrl,
	type Instant,
	instantFrom,
	type ProjectId,
	parseHttpsUrl,
	parseInstant,
	parseRegistrationRef,
	parseScope,
	parseScopes,
	parseSessionBinding,
	type RegistrationRef,
	type Scope,
	type SessionBinding,
	type SessionBindingInput,
	type SessionId,
	scopesAddedBy,
	scopesSubsetOf,
	sessionBindingMismatches,
	sessionBindingsMatch,
	type TenantId,
} from "./types.js";
