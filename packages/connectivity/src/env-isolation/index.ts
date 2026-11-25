export {
	assertComposedIsolation,
	type ComposedIsolationVerdict,
} from "./compose.js";
export {
	ELEVATED_ACCESS_SCOPE_PORT,
	type ElevatedAccessRefusal,
	type ElevatedCapabilityIssuer,
	type ElevatedCapabilityTrust,
	type ElevatedCapabilityVerifier,
	type ElevatedSvidClaims,
	elevatedDeniedEvent,
	type MintElevatedInput,
	mintElevatedAccessCapability,
	type VerifiedElevatedAccess,
	verifyElevatedAccessCapability,
} from "./elevated-capability.js";
export {
	type EnvIsolationEvalContext,
	type EnvIsolationVerdict,
	evaluateEnvIsolation,
} from "./evaluate.js";
export {
	ACCESS_EVENT_SCHEMA_VERSION,
	ACCESS_EVENTS,
	type AccessEvent,
	type AccessEventType,
	createAccessEvent,
} from "./events.js";
export {
	BREAK_GLASS_SCHEMA,
	type BreakGlassGrant,
	BreakGlassService,
	CROSS_ENV_GRANT_SCHEMA,
	type CrossEnvGrant,
	CrossEnvGrantStore,
	ELEVATED_ACCESS_SCHEMA,
	type ElevatedAccessCapability,
} from "./grants.js";
export {
	assertLocalNamedEndpointBackend,
	evaluateOverlayJoin,
	hoboDevOverlayJoinAllowed,
	type OverlayJoinDecision,
	type OverlayJoinRequest,
	recordOverlayJoinDenied,
} from "./local-airgap.js";
export {
	type AssignMembershipInput,
	assertMembershipIntegrity,
	ENV_MEMBERSHIP_SCHEMA,
	type EnvMembership,
	EnvMembershipService,
} from "./membership.js";
export {
	DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK,
	ENV_ISOLATION_RAIL_POLICY_PACK_REF,
	ENV_NETWORK_ISOLATION_POLICY_PACK_ID,
	ENV_NETWORK_ISOLATION_POLICY_PACK_VERSION,
	type EnvNetworkIsolationPolicyPack,
	parseEnvNetworkIsolationPolicyPack,
} from "./policy-pack.js";
export {
	createEnvNetworkIsolationRegistry,
	type EnvControlPlanePartition,
	type EnvNetworkIsolationRegistry,
	type EnvNetworkIsolationRegistryOptions,
	type EnvOverlayPlane,
	type EnvOverlays,
	envIsolationTags,
} from "./registry.js";
export {
	BREAK_GLASS_TTL_SECONDS,
	classesDiffer,
	defaultTierForClass,
	ELEVATED_CAPABILITY_TTL_SECONDS,
	ENV_TAG_PREFIX,
	ISOLATION_CLASSES,
	ISOLATION_TIERS,
	type IsolationClass,
	type IsolationTier,
	isExpired,
	isolationClassTag,
	isShortLivedClass,
	parseIsolationClass,
	SHORT_LIVED_MEMBERSHIP_TTL_SECONDS,
} from "./types.js";
