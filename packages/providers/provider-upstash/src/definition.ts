/**
 * The product definition the catalog selects over.
 *
 * This is a *kv* product: it implements `kv.redis-compatible/v1` natively and
 * therefore `kv.key-value/v1`, which that profile refines. What it very
 * deliberately does not implement is anything in the queue or topic families.
 * Redis has lists, streams, and pub/sub, and every one of them is regularly
 * mistaken for a queue; none of them is declared here, and
 * `@hobo/kv-redis-compatible` carries the guard that keeps a future edit from
 * quietly adding one.
 *
 * Every claim below is either documented by Upstash and dated, or deliberately
 * absent. Absent beats optimistic: an unset structured capability fails a
 * `required` feature gate, which is the correct outcome for something nobody
 * has verified.
 */
import type {
	BindleRuntime,
	ClaimAtomicity,
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	ProviderClass,
	SelectionCandidate,
} from "@hobo/capability-profiles";
import { assertNoQueueTopicImplication } from "@hobo/kv-redis-compatible";

// public-contract: provider id every catalog and receipt keys on.
export const UPSTASH_PROVIDER_ID = "upstash" as const;

/** The product. */
// public-contract: product id selection and receipts resolve.
export const UPSTASH_DEFINITION_ID = "upstash.temporary-redis/v1" as const;

/**
 * Stable alias.
 *
 * `temporary` describes what it is before a claim; `claimable` describes what
 * can be done about that. Catalogs written against either name resolve to the
 * same product, and {@link UPSTASH_DEFINITION_IDS} is what a registry should
 * index so neither spelling becomes a second product by accident.
 */
// public-contract: stable alias id resolving to the same product.
export const UPSTASH_ALIAS_DEFINITION_ID =
	"upstash.claimable-redis/v1" as const;

export const UPSTASH_DEFINITION_IDS = [
	UPSTASH_DEFINITION_ID,
	UPSTASH_ALIAS_DEFINITION_ID,
] as const;

/** Date a human read the official sources listed in the README. */
// public-contract: evidence date a trust policy ages against.
export const UPSTASH_EVIDENCE_CHECKED_AT = "2026-08-08";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * What the conformance claim actually covers.
 *
 * The suffix is not decoration. This driver's REST executor was run against
 * the reference store in `@hobo/kv-redis-compatible` — the command mapping,
 * the REST envelope, the error mapping — offline. It was **not** run against a
 * live Upstash database, so the claim is "this adapter implements the profile
 * correctly", not "Upstash was measured". The README says the same thing in
 * words, and a catalog owner who needs the stronger claim should re-sign this
 * ref after a live run.
 */
// public-contract: conformance evidence locator carried on every implementation.
export const UPSTASH_CONFORMANCE_REF =
	"hobo.conformance/kv.redis-compatible/v1#upstash.temporary-redis@offline-reference-store@2026-08-08";

// public-contract: bootstrap strategy ref the planner dispatches on.
export const UPSTASH_BOOTSTRAP_STRATEGY_REF =
	"bootstrap.upstash.no-signup/v1" as const;
// public-contract: claim strategy ref the claim runner dispatches on.
export const UPSTASH_CLAIM_STRATEGY_REF = "claim.upstash.database/v1" as const;
// public-contract: compiler ref the plan records.
export const UPSTASH_COMPILER_REF =
	"compiler.upstash.temporary-redis/v1" as const;
// public-contract: executor ref the plan records.
export const UPSTASH_EXECUTOR_REF =
	"executor.upstash.temporary-redis/v1" as const;
// public-contract: permission profile ref the gatekeeper resolves.
export const UPSTASH_PERMISSION_PROFILE_REF =
	"permission.upstash.anonymous/v1" as const;
// public-contract: trust evidence locator a policy resolves and dates.
export const UPSTASH_TRUST_EVIDENCE_REF =
	"trust.upstash.temporary-redis@2026-08-08" as const;

/**
 * Facts about the unclaimed tier.
 *
 * `expiryHours` is documentation, not a source of truth: the driver records
 * the expiry the provider reports in the response and never computes one from
 * this number. It is here so a plan can *say* what to expect before the call.
 */
export const UPSTASH_UNCLAIMED_LIMITS = {
	documentedExpiryHours: 72,
	transport: "https-rest",
	// Deliberately absent: maxValueBytes, maxCommandsPerDay, maxStorageBytes,
	// region. Upstash publishes free-tier numbers, but not for *this* surface,
	// and quoting the account free tier here would be an invented fact.
} as const;

/**
 * Only REST is claimed.
 *
 * Upstash databases do speak RESP over TLS, but the no-signup response
 * documents an HTTPS endpoint and a bearer token, and this driver has no
 * conformance evidence for a protocol connection built out of them. So
 * `binding.redis-protocol/v1` is not produced. Adding it is a conformance
 * task, not a declaration edit.
 */
export const UPSTASH_BINDING_PROFILE_REFS = ["binding.redis-rest/v1"] as const;

export const UPSTASH_PROFILE_IMPLEMENTATIONS: readonly ProfileImplementation[] =
	[
		{
			profileId: "kv.redis-compatible/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: UPSTASH_CONFORMANCE_REF,
			conformance: "pass",
		},
		{
			// Declared explicitly rather than left to refinement, so a requirement
			// written against the plainer profile matches without the matcher
			// having to walk the graph.
			profileId: "kv.key-value/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: UPSTASH_CONFORMANCE_REF,
			conformance: "pass",
		},
	];

/**
 * Capabilities substantiated by the offline conformance run.
 *
 * `maxValueBytes` is missing on purpose. The suite can measure it, but only
 * against a real endpoint, and the reference store's bound is the reference
 * store's, not Upstash's.
 */
export const UPSTASH_STRUCTURED_CAPABILITIES = {
	ttl: true,
	atomicIncrement: true,
	sortedSets: true,
	restTransport: true,
	redisCommandSemantics: true,
	tls: true,
	bootstrap: "public-anonymous-claimable",
	claimBoundary: "resource",
	expirySource: "provider-reported",
};

/**
 * Enforced at module load, so adding `queue.at-least-once/v1` to the list
 * above on the strength of "Redis has lists" is a build failure rather than a
 * delivery guarantee nobody tested.
 */
assertNoQueueTopicImplication(
	UPSTASH_PROFILE_IMPLEMENTATIONS,
	`${UPSTASH_DEFINITION_ID} declaration`,
);

export type UpstashCandidateOverrides = {
	/** Epoch ms after which the trust evidence must be re-gathered. */
	readonly evidenceExpiresAtMs?: number;
	/** Set false until the catalog owner has signed this evidence. */
	readonly evidenceSignatureValid?: boolean;
	readonly secretCustodyAvailable?: boolean;
	readonly hasRegisteredDriver?: boolean;
	readonly conformance?: ProfileImplementation["conformance"];
	/** Use the alias id, for a catalog that indexes products by that name. */
	readonly definitionId?: (typeof UPSTASH_DEFINITION_IDS)[number];
};

/**
 * Runtime models.
 *
 * The binding is HTTPS with a bearer token, which every runtime model can
 * make. Restricting this to `paas` and `serverless_faas` would exclude exactly
 * the edge and WASM callers the REST transport exists for.
 */
const UPSTASH_RUNTIME_MODELS: readonly BindleRuntime[] = [
	"wasm",
	"oci",
	"vm_iaas",
	"paas",
	"serverless_faas",
];

const UPSTASH_CONTINUITY = {
	// Claiming moves the existing database into an account. The endpoint and
	// the data are the same ones; what changes is that the expiry is lifted.
	endpoint: "preserved",
	data: "preserved",
	// The creating party still holds the token it was handed. Only an owner
	// rotation in the console ends that, which is why rotation is a *blocking*
	// post-claim action rather than an optional tidy-up.
	credentials: "retained",
} as const;

const UPSTASH_PROVIDER_CLASS: ProviderClass = "verified-emerging";
const UPSTASH_CREATOR_AUTHORITY: CreatorAuthorityAfterClaim = "rotatable";
const UPSTASH_CLAIM_ATOMICITY: ClaimAtomicity = "single-resource";

/** (1) the console claim ceremony, (2) the owner's token rotation. */
export const UPSTASH_CLAIM_ACTION_COUNT = 2;

export function createUpstashTemporaryRedisCandidate(
	overrides: UpstashCandidateOverrides = {},
): SelectionCandidate {
	const conformance = overrides.conformance ?? "pass";
	return {
		definitionId: overrides.definitionId ?? UPSTASH_DEFINITION_ID,
		providerId: UPSTASH_PROVIDER_ID,
		implementsProfiles: UPSTASH_PROFILE_IMPLEMENTATIONS.map(
			(implementation) => ({
				...implementation,
				conformance,
			}),
		),
		runtimeModels: UPSTASH_RUNTIME_MODELS,
		structuredCapabilities: UPSTASH_STRUCTURED_CAPABILITIES,
		producesBindingProfiles: [...UPSTASH_BINDING_PROFILE_REFS],
		// No documented export or import path on the anonymous surface. An
		// empty list is the honest answer and it costs the candidate a
		// portability gate, which is the correct price.
		migrationProfiles: [],
		providerClass: UPSTASH_PROVIDER_CLASS,
		evidenceExpiresAtMs:
			overrides.evidenceExpiresAtMs ??
			Date.parse(UPSTASH_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
		evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
		creatorAuthorityAfterClaim: UPSTASH_CREATOR_AUTHORITY,
		claimAtomicity: UPSTASH_CLAIM_ATOMICITY,
		claimActionCount: UPSTASH_CLAIM_ACTION_COUNT,
		continuity: UPSTASH_CONTINUITY,
		// No dump/restore endpoint on this surface.
		supportsExport: false,
		// Console-only, by a human, after the claim.
		supportsRotation: true,
		// No delete or revoke endpoint at all. Expiry is the only teardown.
		supportsRevocation: false,
		// Anonymous, on the provider's own free allowance. HoBo sponsors nothing.
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: overrides.hasRegisteredDriver ?? true,
		secretCustodyAvailable: overrides.secretCustodyAvailable ?? true,
	};
}

export const UPSTASH_TEMPORARY_REDIS_CANDIDATE: SelectionCandidate =
	createUpstashTemporaryRedisCandidate();

export type PlacementConstraint = {
	readonly key: string;
	readonly operator: "in" | "not-in" | "equals" | "exists";
	readonly values: readonly string[];
};

export type RemediationHint = {
	readonly code: string;
	readonly message: string;
};

/**
 * The semantics block of a `hobo.resource-definition/vNext`.
 *
 * Structurally the `ResourceDefinitionSemantics` exported by `@hobo/cloud`.
 * It is restated here rather than imported because `@hobo/cloud` already
 * depends on provider packages, and a provider depending back on it would
 * close a cycle. The shared enums come from `@hobo/capability-profiles`, which
 * is where `@hobo/cloud` gets them too, so the fields that carry meaning are
 * the same types rather than lookalikes. `test/definition.test.ts` pins the
 * assignability.
 */
// public-contract: resource-definition schema version shared with @hobo/cloud.
export const RESOURCE_DEFINITION_VNEXT_SCHEMA =
	"hobo.resource-definition/vNext" as const;

export type UpstashResourceSemantics = {
	readonly schemaVersion: typeof RESOURCE_DEFINITION_VNEXT_SCHEMA;
	readonly productId: string;
	readonly displayName: string;
	readonly implementsProfiles: readonly ProfileImplementation[];
	readonly runtimeModels: readonly BindleRuntime[];
	readonly structuredCapabilities: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
	readonly placementConstraints: readonly PlacementConstraint[];
	readonly producesBindingProfiles: readonly string[];
	readonly requiresConnectivityProfiles?: readonly string[];
	readonly migrationProfiles: readonly string[];
	readonly bootstrapStrategyRef: string;
	readonly guestLeaseTemplateRef?: string;
	readonly claimStrategyRef: string;
	readonly compilerRef: string;
	readonly executorRef: string;
	readonly permissionProfileRef: string;
	readonly trustEvidenceRef: string;
	readonly sourceEvidenceRefs: readonly string[];
	readonly remediation: readonly RemediationHint[];
	readonly providerClass: ProviderClass;
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimAtomicity: ClaimAtomicity;
	readonly claimActionCount: number;
	readonly continuity: typeof UPSTASH_CONTINUITY;
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	readonly sponsorExposureMinorUnits: number;
	readonly secretCustodyAvailable: boolean;
};

export type ProviderSourceRef = {
	readonly url: string;
	readonly checkedAt: string;
	readonly note: string;
	/** False when the URL could not be fetched and the fact rests on docs. */
	readonly verified: boolean;
};

export const UPSTASH_SOURCE_REFS: readonly ProviderSourceRef[] = [
	{
		url: "https://upstash.com/docs/redis/sdks/ts/getstarted",
		checkedAt: UPSTASH_EVIDENCE_CHECKED_AT,
		note: "REST client usage: https endpoint plus bearer token, command-array request body, JSON {result} response",
		verified: true,
	},
	{
		url: "https://upstash.com/docs/redis/help/support",
		checkedAt: UPSTASH_EVIDENCE_CHECKED_AT,
		note: "Support surface; no documented delete or token-rotation API for the no-signup temporary database",
		verified: true,
	},
	{
		url: "https://upstash.com/start-redis",
		checkedAt: UPSTASH_EVIDENCE_CHECKED_AT,
		note: "No-signup surface: POST with an Idempotency-Key UUIDv4 that becomes the database id; markdown response with Database ID, Endpoint, Token, console URL",
		verified: true,
	},
	{
		url: "https://upstash.com/blog/redis-database-for-agents",
		checkedAt: UPSTASH_EVIDENCE_CHECKED_AT,
		note: "Announcement: 72-hour expiry for an unclaimed database, claim through the console URL to keep it, metrics URL",
		verified: true,
	},
];

export function createUpstashResourceSemantics(
	overrides: UpstashCandidateOverrides = {},
): UpstashResourceSemantics {
	const candidate = createUpstashTemporaryRedisCandidate(overrides);
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		productId: UPSTASH_DEFINITION_ID,
		displayName: "Upstash temporary Redis (no signup)",
		implementsProfiles: candidate.implementsProfiles,
		runtimeModels: candidate.runtimeModels,
		structuredCapabilities: candidate.structuredCapabilities,
		placementConstraints: [],
		producesBindingProfiles: candidate.producesBindingProfiles,
		requiresConnectivityProfiles: [],
		migrationProfiles: candidate.migrationProfiles,
		bootstrapStrategyRef: UPSTASH_BOOTSTRAP_STRATEGY_REF,
		claimStrategyRef: UPSTASH_CLAIM_STRATEGY_REF,
		compilerRef: UPSTASH_COMPILER_REF,
		executorRef: UPSTASH_EXECUTOR_REF,
		permissionProfileRef: UPSTASH_PERMISSION_PROFILE_REF,
		trustEvidenceRef: UPSTASH_TRUST_EVIDENCE_REF,
		sourceEvidenceRefs: UPSTASH_SOURCE_REFS.map((source) => source.url),
		remediation: [
			{
				code: "LEASE_EXPIRED",
				message:
					"An unclaimed Upstash temporary Redis is reaped at the provider-reported expiry and cannot be recovered. Claim it through the console URL in the provision receipt, or provision a new one with a new idempotency key.",
			},
			{
				code: "CLAIM_EXPIRED",
				message:
					"The claim window closed with the database unclaimed. There is no re-claim path; provision a replacement and migrate at the application layer, because this surface publishes no export endpoint.",
			},
			{
				code: "PROVIDER_CONTRACT_CHANGED",
				message:
					"The no-signup response is human-readable markdown with no version header, so a wording change breaks the parser by design rather than being guessed around. Update the parser and bump upstash.start-redis.markdown/v1.",
			},
			{
				code: "CLEANUP_FAILED",
				message:
					"This surface publishes no delete endpoint. A database can only be left to expire, or claimed and then deleted from the Upstash console by its owner.",
			},
		],
		providerClass: candidate.providerClass,
		...(candidate.evidenceExpiresAtMs !== undefined
			? { evidenceExpiresAtMs: candidate.evidenceExpiresAtMs }
			: undefined),
		evidenceSignatureValid: candidate.evidenceSignatureValid,
		creatorAuthorityAfterClaim: candidate.creatorAuthorityAfterClaim,
		claimAtomicity: candidate.claimAtomicity,
		claimActionCount: candidate.claimActionCount,
		continuity: UPSTASH_CONTINUITY,
		supportsExport: candidate.supportsExport,
		supportsRotation: candidate.supportsRotation,
		supportsRevocation: candidate.supportsRevocation,
		sponsorExposureMinorUnits: candidate.sponsorExposureMinorUnits,
		secretCustodyAvailable: candidate.secretCustodyAvailable,
	};
}

export const UPSTASH_RESOURCE_SEMANTICS: UpstashResourceSemantics =
	createUpstashResourceSemantics();

/**
 * The legacy half of a `ResourceDefinitionVNext`.
 *
 * `satisfies` is a pure function of the declared feature list — no clock, no
 * network, no ambient state — so the definition as a whole stays data.
 */
export type UpstashResourceDefinition = {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly features: readonly string[];
	readonly regions: readonly string[];
	readonly specificity: number;
	readonly priority: number;
	readonly cost: {
		readonly sku: string;
		readonly unit: string;
		readonly marginalPrice: string;
	};
	satisfies(req: { port: string; features?: string[] }): {
		readonly kind: "full" | "partial" | "none";
		readonly missing?: readonly string[];
	};
	readonly semantics: UpstashResourceSemantics;
};

const LEGACY_PORT = "kv";
const LEGACY_FEATURES: readonly string[] = [
	"ttl",
	"atomicIncrement",
	"sortedSets",
	"restTransport",
];

export function createUpstashResourceDefinition(
	overrides: UpstashCandidateOverrides = {},
): UpstashResourceDefinition {
	return {
		id: overrides.definitionId ?? UPSTASH_DEFINITION_ID,
		providerId: UPSTASH_PROVIDER_ID,
		port: LEGACY_PORT,
		features: LEGACY_FEATURES,
		// The no-signup surface does not let the caller pick, and it does not
		// report one back. Claiming a region we cannot observe would be a
		// residency fact invented out of nothing.
		regions: [],
		specificity: 20,
		priority: 0,
		// Free on the provider's allowance until it expires or is claimed.
		cost: { sku: "upstash-temporary-redis", unit: "hour", marginalPrice: "0" },
		satisfies(req) {
			if (req.port !== LEGACY_PORT) return { kind: "none" };
			const missing = (req.features ?? []).filter(
				(feature) => !LEGACY_FEATURES.includes(feature),
			);
			return missing.length === 0
				? { kind: "full" }
				: { kind: "partial", missing };
		},
		semantics: createUpstashResourceSemantics(overrides),
	};
}

export const UPSTASH_RESOURCE_DEFINITION: UpstashResourceDefinition =
	createUpstashResourceDefinition();
