/**
 * The product definition the catalog selects over.
 *
 * ttl.sh is an **artifact transport**, and the whole point of writing its
 * definition carefully is that it must never read as hosting. It stores no
 * application state, grants no ownership, issues no credential, and answers to
 * nobody once the TTL runs out. The declaration says exactly that:
 *
 * - `claimActionCount: 0` and a `none-expire` claim mode. There is no ceremony
 *   because there is nothing to take ownership *of* — no account, no console,
 *   no transfer. A definition with even one claim action would be advertising a
 *   path that does not exist.
 * - `retain-until-provider-expiry` cleanup. There is no delete endpoint. The
 *   only teardown is the registry's own reaper, and pretending otherwise would
 *   make a cleanup failure look like a HoBo bug instead of a documented fact.
 * - `bucket.oci-artifact-transport/v1`, refining `bucket.content-addressed/v1`.
 *   That is honest about what it is — immutable digest-addressed bytes over
 *   HTTPS — and it deliberately claims nothing in the `web`, `api`, or `data`
 *   families, so a requirement for hosting can never resolve to this.
 *
 * Every fact below is either documented by ttl.sh and dated, or absent. Absent
 * beats optimistic: an unset structured capability fails a `required` feature
 * gate, which is the correct outcome for something nobody has verified.
 */
import type {
	BindleRuntime,
	CapabilityProfileDescriptor,
	ClaimAtomicity,
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	ProviderClass,
	SelectionCandidate,
} from "@hobo/capability-profiles";
import type {
	BootstrapClass,
	GuestLeaseCleanupPolicy,
	OwnershipTransitionMode,
} from "@hobo/claims";

// public-contract: the provider id the catalog, receipts, and facts key on.
export const TTL_SH_PROVIDER_ID = "ttl-sh" as const;

/** The product. */
// public-contract: the definition id a plan pins and a receipt records.
export const TTL_SH_DEFINITION_ID = "ttl-sh.ephemeral-oci-artifact/v1" as const;

/** Date a human read the sources listed in the README. */
// public-contract: the evidence date a catalog owner audits before signing.
export const TTL_SH_EVIDENCE_CHECKED_AT = "2026-08-08";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The capability profile this product implements.
 *
 * It is declared here rather than in `@hobo/capability-profiles` because the
 * profile registry is open by design: a provider package registers what it
 * needs without editing a central catalog. It refines
 * `bucket.content-addressed/v1` because that is precisely what an OCI registry
 * is — immutable content addressed by digest — and it adds the two guarantees
 * that make this one different from durable object storage: the bytes expire,
 * and anyone who knows the name can read them.
 */
// public-contract: the profile id requirements match against; changing it is a selection-visible break.
export const TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID =
	"bucket.oci-artifact-transport/v1" as const;

export const TTL_SH_ARTIFACT_TRANSPORT_PROFILE: CapabilityProfileDescriptor = {
	schemaVersion: "hobo.capability-profile/v1",
	id: TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID,
	primitive: "bucket",
	displayName: "OCI artifact transport",
	description:
		"A registry that accepts an OCI image and serves it back by reference so another system can pull it. A transport for handing over bytes, not a place to keep them: implementations may expire content and may serve it to anyone holding the reference.",
	refines: ["bucket.content-addressed/v1"],
	requirementSchemaRef:
		"hobo.capability-requirement/bucket-oci-artifact-transport-v1",
	conformanceSuiteRef: "conformance.bucket.oci-artifact-transport/v1",
	features: [
		{
			key: "maxTtlMinutes",
			description: "Longest lifetime the registry will hold an artifact.",
			valueKind: "integer",
		},
		{
			key: "anonymousPush",
			description: "Accepts a push with no account and no credential.",
			valueKind: "boolean",
		},
		{
			key: "deleteOnDemand",
			description: "Content can be removed before its lifetime ends.",
			valueKind: "boolean",
		},
	],
	guarantees: [
		{
			key: "digestAddressed",
			description: "Content is addressed and verified by its sha256 digest.",
			valueKind: "boolean",
		},
		{
			key: "tls",
			description: "Content is transferred over TLS.",
			valueKind: "boolean",
		},
	],
	maturity: "experimental",
	sourceRefs: [
		{
			url: "https://ttl.sh",
			checkedAt: TTL_SH_EVIDENCE_CHECKED_AT,
			note: "anonymous ephemeral OCI registry; push to ttl.sh/<name>:<ttl>, deleted at the TTL, 24h maximum",
		},
		{
			url: "https://github.com/opencontainers/distribution-spec",
			checkedAt: TTL_SH_EVIDENCE_CHECKED_AT,
			note: "the /v2/ API surface and digest addressing this profile asserts",
		},
	],
};

// public-contract: strategy/compiler/executor/permission/trust refs a resource definition resolves by name.
export const TTL_SH_BOOTSTRAP_STRATEGY_REF =
	"bootstrap.ttl-sh.anonymous-push/v1" as const;
// public-contract: same registry of refs.
export const TTL_SH_CLAIM_STRATEGY_REF = "claim.ttl-sh.none-expire/v1" as const;
// public-contract: same registry of refs.
export const TTL_SH_COMPILER_REF =
	"compiler.ttl-sh.ephemeral-oci-artifact/v1" as const;
// public-contract: same registry of refs.
export const TTL_SH_EXECUTOR_REF =
	"executor.ttl-sh.ephemeral-oci-artifact/v1" as const;
// public-contract: same registry of refs.
export const TTL_SH_PERMISSION_PROFILE_REF =
	"permission.ttl-sh.anonymous/v1" as const;
// public-contract: the trust-evidence ref, dated so a re-check is visible as a new value.
export const TTL_SH_TRUST_EVIDENCE_REF =
	"trust.ttl-sh.ephemeral-oci-artifact@2026-08-08" as const;

/**
 * The bootstrap class.
 *
 * `public-anonymous`, not `anonymous-claimable`: there is no claim path at
 * all, and the two classes are the difference between "you may take this
 * later" and "you never can".
 */
// public-contract: the bootstrap class a policy gate reads; `public-anonymous` is what forbids a claim path.
export const TTL_SH_BOOTSTRAP_CLASS: BootstrapClass = "public-anonymous";

/**
 * The claim mode.
 *
 * Named for what happens instead of a claim: the lease ends by expiry. The
 * ownership-transition vocabulary in `@hobo/claims` calls this `none`, and
 * {@link TTL_SH_OWNERSHIP_TRANSITION_MODE} pins the mapping so the two spellings
 * cannot drift into meaning different things.
 */
// public-contract: the claim mode receipts and the catalog report.
export const TTL_SH_CLAIM_MODE = "none-expire" as const;

// public-contract: the `@hobo/claims` spelling of the same fact.
export const TTL_SH_OWNERSHIP_TRANSITION_MODE: OwnershipTransitionMode = "none";

/** No delete endpoint exists. The registry's own reaper is the only teardown. */
// public-contract: the cleanup policy the claim plane acts on; nothing here is deletable.
export const TTL_SH_CLEANUP_POLICY: GuestLeaseCleanupPolicy =
	"retain-until-provider-expiry";

/** There is no ceremony, so there are no actions. */
export const TTL_SH_CLAIM_ACTION_COUNT = 0;

/**
 * The binding a workload consumes: a pull reference, nothing else.
 *
 * No credential accompanies it, because the registry issues none — which also
 * means the reference itself is the whole access control, and that is why the
 * name must be unguessable.
 */
export const TTL_SH_BINDING_PROFILE_REFS = [
	"binding.oci-image-pull/v1",
] as const;

/**
 * Facts about the anonymous tier.
 *
 * `maxTtlHours` is the documented ceiling, and the reference parser refuses
 * anything above it rather than clamping, so a plan that says 24h is a plan the
 * registry agreed to.
 */
export const TTL_SH_LIMITS = {
	documentedMaxTtlHours: 24,
	transport: "https-oci-registry",
	// Deliberately absent: maxArtifactBytes, rate limits, regional placement.
	// ttl.sh publishes none of them, and inventing a number here would put a
	// fabricated limit into a plan.
} as const;

/**
 * The conformance claim, and its exact scope.
 *
 * The suffix is not decoration. This package's reference parser, transport
 * guard, argv builder, and receipt projection were exercised offline against
 * fixtures. No push was made to the live registry, so the claim is "this
 * adapter implements the profile correctly", not "ttl.sh was measured".
 */
// public-contract: the conformance ref a reviewer reads to see what was actually exercised, and how.
export const TTL_SH_CONFORMANCE_REF =
	"hobo.conformance/bucket.oci-artifact-transport/v1#ttl-sh.ephemeral-oci-artifact@offline-fixtures@2026-08-08";

export const TTL_SH_PROFILE_IMPLEMENTATIONS: readonly ProfileImplementation[] =
	[
		{
			profileId: TTL_SH_ARTIFACT_TRANSPORT_PROFILE_ID,
			versionRange: ">=1",
			realization: "native",
			conformanceRef: TTL_SH_CONFORMANCE_REF,
			conformance: "pass",
		},
	];

/**
 * Capabilities substantiated by the offline run and the documented behaviour.
 *
 * `durable: false` and `deleteOnDemand: false` are the two that matter. They
 * are what a policy gate reads to refuse this product for anything that needs
 * to still be there tomorrow, or to be removable on request.
 */
export const TTL_SH_STRUCTURED_CAPABILITIES = {
	digestAddressed: true,
	tls: true,
	anonymousPush: true,
	authenticated: false,
	durable: false,
	deleteOnDemand: false,
	publiclyReadable: true,
	maxTtlMinutes: 24 * 60,
	transport: "https-oci-registry",
	bootstrap: TTL_SH_BOOTSTRAP_CLASS,
	claimMode: TTL_SH_CLAIM_MODE,
	claimActions: TTL_SH_CLAIM_ACTION_COUNT,
	cleanup: "expiry",
	expirySource: "computed-from-ttl",
};

/**
 * Runtime models.
 *
 * `oci` only, and that is not a limitation of the transport — it is what the
 * transport carries. A WASM component or a PaaS build artifact is not an OCI
 * image, and listing those runtimes would let Matching pick this product for a
 * handover it cannot perform.
 */
const TTL_SH_RUNTIME_MODELS: readonly BindleRuntime[] = ["oci"];

const TTL_SH_CONTINUITY = {
	// There is no claim, so there is no "after" for an endpoint to survive
	// into. The reference simply stops resolving.
	endpoint: "not-applicable",
	// The bytes are deleted at the TTL. Anyone who needs them afterwards
	// needs a different registry, and the definition should say so loudly.
	data: "discarded",
	// None were ever issued.
	credentials: "not-applicable",
} as const;

/**
 * `experimental`.
 *
 * ttl.sh is a free community service with no SLA and no support channel. Under
 * the default trust policy that keeps it out of automatic selection unless an
 * operator lowers `minimumProviderClass` deliberately, which is the right
 * default for something whose availability nobody has promised.
 */
const TTL_SH_PROVIDER_CLASS: ProviderClass = "experimental";

/** Nothing is held afterwards because nothing was ever held. */
const TTL_SH_CREATOR_AUTHORITY: CreatorAuthorityAfterClaim = "absent";

const TTL_SH_CLAIM_ATOMICITY: ClaimAtomicity = "single-resource";

export type TtlShCandidateOverrides = {
	/** Epoch ms after which the trust evidence must be re-gathered. */
	readonly evidenceExpiresAtMs?: number;
	/** Set false until the catalog owner has signed this evidence. */
	readonly evidenceSignatureValid?: boolean;
	readonly hasRegisteredDriver?: boolean;
	readonly conformance?: ProfileImplementation["conformance"];
};

export function createTtlShArtifactTransportCandidate(
	overrides: TtlShCandidateOverrides = {},
): SelectionCandidate {
	const conformance = overrides.conformance ?? "pass";
	return {
		definitionId: TTL_SH_DEFINITION_ID,
		providerId: TTL_SH_PROVIDER_ID,
		implementsProfiles: TTL_SH_PROFILE_IMPLEMENTATIONS.map(
			(implementation) => ({
				...implementation,
				conformance,
			}),
		),
		runtimeModels: TTL_SH_RUNTIME_MODELS,
		structuredCapabilities: TTL_SH_STRUCTURED_CAPABILITIES,
		producesBindingProfiles: [...TTL_SH_BINDING_PROFILE_REFS],
		// No export path, and none is needed: the caller already holds the
		// artifact it pushed. An empty list is the honest answer.
		migrationProfiles: [],
		providerClass: TTL_SH_PROVIDER_CLASS,
		evidenceExpiresAtMs:
			overrides.evidenceExpiresAtMs ??
			Date.parse(TTL_SH_EVIDENCE_CHECKED_AT) + NINETY_DAYS_MS,
		evidenceSignatureValid: overrides.evidenceSignatureValid ?? true,
		creatorAuthorityAfterClaim: TTL_SH_CREATOR_AUTHORITY,
		claimAtomicity: TTL_SH_CLAIM_ATOMICITY,
		claimActionCount: TTL_SH_CLAIM_ACTION_COUNT,
		continuity: TTL_SH_CONTINUITY,
		supportsExport: false,
		supportsRotation: false,
		// No delete endpoint. Expiry is the only teardown there is.
		supportsRevocation: false,
		// Anonymous, on the service's own allowance. HoBo sponsors nothing.
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: overrides.hasRegisteredDriver ?? true,
		// Vacuously satisfied: there is no credential to deposit, so the
		// custody gate has nothing to fail on. This is not a claim that
		// custody was exercised — see the README.
		secretCustodyAvailable: true,
	};
}

export const TTL_SH_ARTIFACT_TRANSPORT_CANDIDATE: SelectionCandidate =
	createTtlShArtifactTransportCandidate();

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
 * Structurally the `ResourceDefinitionSemantics` exported by `@hobo/cloud`. It
 * is restated here rather than imported because `@hobo/cloud` already depends
 * on provider packages, and a provider depending back on it would close a
 * cycle. The fields that carry meaning are the same types from
 * `@hobo/capability-profiles` that `@hobo/cloud` uses, and
 * `test/definition.test.ts` pins the assignability.
 */
// public-contract: the schema tag `@hobo/cloud` dispatches on when it reads a definition.
export const RESOURCE_DEFINITION_VNEXT_SCHEMA =
	"hobo.resource-definition/vNext" as const;

export type TtlShResourceSemantics = {
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
	readonly continuity: typeof TTL_SH_CONTINUITY;
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	readonly sponsorExposureMinorUnits: number;
	readonly secretCustodyAvailable: boolean;
	/** Lifecycle facts that have no home in the shared block. */
	readonly bootstrapClass: BootstrapClass;
	readonly claimMode: typeof TTL_SH_CLAIM_MODE;
	readonly cleanupPolicy: GuestLeaseCleanupPolicy;
	readonly ownershipTransitionMode: OwnershipTransitionMode;
};

export type ProviderSourceRef = {
	readonly url: string;
	readonly checkedAt: string;
	readonly note: string;
	/** False when the URL could not be fetched and the fact rests on docs. */
	readonly verified: boolean;
};

export const TTL_SH_SOURCE_REFS: readonly ProviderSourceRef[] = [
	{
		url: "https://ttl.sh",
		checkedAt: TTL_SH_EVIDENCE_CHECKED_AT,
		note: 'anonymous ephemeral registry: docker push ttl.sh/<name>:<ttl>, no login, image deleted at the TTL, "TTL from minutes to 24 hours" with :5m | :1h | :24h shown as the accepted forms',
		// Fetched from the live landing page on the checked date, which is what
		// the 24-hour ceiling and the zero-credential rule are pinned to.
		verified: true,
	},
	{
		url: "https://github.com/replicatedhq/ttl.sh",
		checkedAt: TTL_SH_EVIDENCE_CHECKED_AT,
		note: "implementation and operating notes: anonymous, no delete endpoint, TTL supplied as the image tag",
		// The repository responds, but its contents were not read on the checked
		// date, so the "no delete endpoint" half of this note is still resting on
		// documentation rather than on something re-read here.
		verified: false,
	},
	{
		url: "https://github.com/opencontainers/distribution-spec",
		checkedAt: TTL_SH_EVIDENCE_CHECKED_AT,
		note: "the /v2/ manifest and blob API the transport guard allowlists",
		verified: true,
	},
];

export function createTtlShResourceSemantics(
	overrides: TtlShCandidateOverrides = {},
): TtlShResourceSemantics {
	const candidate = createTtlShArtifactTransportCandidate(overrides);
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		productId: TTL_SH_DEFINITION_ID,
		displayName: "ttl.sh ephemeral OCI artifact transport",
		implementsProfiles: candidate.implementsProfiles,
		runtimeModels: candidate.runtimeModels,
		structuredCapabilities: candidate.structuredCapabilities,
		placementConstraints: [],
		producesBindingProfiles: candidate.producesBindingProfiles,
		requiresConnectivityProfiles: [],
		migrationProfiles: candidate.migrationProfiles,
		bootstrapStrategyRef: TTL_SH_BOOTSTRAP_STRATEGY_REF,
		claimStrategyRef: TTL_SH_CLAIM_STRATEGY_REF,
		compilerRef: TTL_SH_COMPILER_REF,
		executorRef: TTL_SH_EXECUTOR_REF,
		permissionProfileRef: TTL_SH_PERMISSION_PROFILE_REF,
		trustEvidenceRef: TTL_SH_TRUST_EVIDENCE_REF,
		sourceEvidenceRefs: TTL_SH_SOURCE_REFS.map((source) => source.url),
		remediation: [
			{
				code: "LEASE_EXPIRED",
				message:
					"A ttl.sh artifact is deleted at its TTL and cannot be recovered or extended. Push the image again — the digest is unchanged, so the new reference addresses the same content — and hand the host the new pull reference.",
			},
			{
				code: "CLEANUP_FAILED",
				message:
					"ttl.sh publishes no delete endpoint. An artifact can only be left to expire; the shortest workable TTL is the only lever for reducing exposure.",
			},
			{
				code: "GUESSABLE_ARTIFACT_NAME",
				message:
					"The registry is unauthenticated, so the artifact name is the only thing keeping the image private. Use the minted UUID or the content-addressed sha256-<digest> name rather than a human-chosen one.",
			},
			{
				code: "REFERENCE_REUSED",
				message:
					"A reference that already carries different content must not be overwritten while a host may be pulling it. Mint a new name for the new artifact.",
			},
			{
				code: "PROVIDER_CONTRACT_CHANGED",
				message:
					"An authentication challenge, a redirect, or a digest mismatch from ttl.sh is a contract change rather than something to work around. Stop, and re-verify the transport guard against the distribution spec before widening it.",
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
		continuity: TTL_SH_CONTINUITY,
		supportsExport: candidate.supportsExport,
		supportsRotation: candidate.supportsRotation,
		supportsRevocation: candidate.supportsRevocation,
		sponsorExposureMinorUnits: candidate.sponsorExposureMinorUnits,
		secretCustodyAvailable: candidate.secretCustodyAvailable,
		bootstrapClass: TTL_SH_BOOTSTRAP_CLASS,
		claimMode: TTL_SH_CLAIM_MODE,
		cleanupPolicy: TTL_SH_CLEANUP_POLICY,
		ownershipTransitionMode: TTL_SH_OWNERSHIP_TRANSITION_MODE,
	};
}

export const TTL_SH_RESOURCE_SEMANTICS: TtlShResourceSemantics =
	createTtlShResourceSemantics();

/**
 * The legacy half of a `ResourceDefinitionVNext`.
 *
 * `satisfies` is a pure function of the declared feature list — no clock, no
 * network, no ambient state — so the definition as a whole stays data.
 */
export type TtlShResourceDefinition = {
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
	readonly semantics: TtlShResourceSemantics;
};

const LEGACY_PORT = "bucket";
const LEGACY_FEATURES: readonly string[] = [
	"digestAddressed",
	"anonymousPush",
	"ephemeral",
	"ociRegistry",
];

export function createTtlShResourceDefinition(
	overrides: TtlShCandidateOverrides = {},
): TtlShResourceDefinition {
	return {
		id: TTL_SH_DEFINITION_ID,
		providerId: TTL_SH_PROVIDER_ID,
		port: LEGACY_PORT,
		features: LEGACY_FEATURES,
		// The service publishes no region and reports none back. Claiming one
		// we cannot observe would be a residency fact invented out of nothing.
		regions: [],
		specificity: 20,
		priority: 0,
		// Free, anonymous, and reaped. There is no meter to read.
		cost: {
			sku: "ttl-sh-ephemeral-artifact",
			unit: "hour",
			marginalPrice: "0",
		},
		satisfies(req) {
			if (req.port !== LEGACY_PORT) return { kind: "none" };
			const missing = (req.features ?? []).filter(
				(feature) => !LEGACY_FEATURES.includes(feature),
			);
			return missing.length === 0
				? { kind: "full" }
				: { kind: "partial", missing };
		},
		semantics: createTtlShResourceSemantics(overrides),
	};
}

export const TTL_SH_RESOURCE_DEFINITION: TtlShResourceDefinition =
	createTtlShResourceDefinition();
