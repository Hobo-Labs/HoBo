import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { BrokerParseError } from "./policies.js";

// Anonymous-to-owned resolution evidence (ADR-0151). A guest deployment is
// resolved before its eventual owner has authenticated with any provider, so
// the receipt is the only durable record of what the human was told and what
// authority HoBo held on their behalf. These records carry references,
// digests, counts, and deadlines — never bearer material. The claim URL, the
// temporary API token, and the database password live in the secret plane and
// are addressed here only by the ids of the things they unlock.

// public-contract: how a caller obtained the authority to deploy before owning anything.
export const BOOTSTRAP_CLASSES = [
	"public-anonymous",
	"proof-of-work",
	"capability-token",
	"agent-self-registration",
	"sponsor-backed",
	"wallet-funded",
	"local-accountless",
	"preauthenticated-agent",
	"user-owned",
] as const;

export type BootstrapClass = (typeof BOOTSTRAP_CLASSES)[number];

// public-contract: how a provider exposes a Bindle primitive on a runtime.
export const REALIZATIONS = ["native", "pack", "bridge"] as const;

export type Realization = (typeof REALIZATIONS)[number];

// public-contract: how far a provider's claim ceremony can be trusted to be all-or-nothing.
export const CLAIM_ATOMICITIES = [
	"single-resource",
	"provider-bundled",
	"best-effort-saga",
] as const;

export type ClaimAtomicity = (typeof CLAIM_ATOMICITIES)[number];

// public-contract: what happens to guest infrastructure that is never claimed.
export const CLEANUP_POLICIES = [
	"delete",
	"retain-temporarily",
	"transfer",
	"migrate",
] as const;

export type CleanupPolicy = (typeof CLEANUP_POLICIES)[number];

// public-contract: what becomes of the pre-claim creator's authority once a human owns the resource.
export const CREATOR_AUTHORITIES_AFTER_CLAIM = [
	"absent",
	"reauthorization-required",
	"rotatable",
	"retained",
	"unknown",
] as const;

export type CreatorAuthorityAfterClaim =
	(typeof CREATOR_AUTHORITIES_AFTER_CLAIM)[number];

// Stable codes so an agent can self-correct a malformed guest resolution
// without reading prose.
const GUEST_CODE = "invalid-guest-evidence";
const OFFER_MISMATCH_CODE = "guest-offer-mismatch";
const SPONSOR_BUDGET_CODE = "sponsor-budget-exceeded";

function fail(code: string, message: string): BrokerParseError {
	return new BrokerParseError(code, `${code}: ${message}`);
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const MAX_CLAIM_ACTIONS = 16;

// domain-view: what a pre-claim caller brings to resolution; wire form is GuestResolutionInput in data-models/broker.proto.
export interface GuestResolutionInput {
	recipeId: string;
	topologyDigest: string;
	offerDigest: string;
	consentDigest: string;
	bootstrapClass: BootstrapClass;
	sponsorCostCapMinorUnits: number;
	maxClaimActions: number;
}

// domain-view: one placement's realization and claim facts; wire form is GuestPlacementEvidence in data-models/broker.proto.
export interface GuestPlacementEvidence {
	resourceId: string;
	definitionId: string;
	realization: Realization;
	runtimeModel: string;
	capabilityProfileRefs: readonly string[];
	bindingProfileRefs?: readonly string[] | undefined;
	connectivityRef?: string | undefined;
	bootstrapClass: BootstrapClass;
	claimMode: string;
	creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
}

// domain-view: the claim-relevant evidence pinned onto a receipt; wire form is GuestResolutionEvidence in data-models/broker.proto.
export interface GuestResolutionEvidence {
	recipeId: string;
	topologyDigest: string;
	offerDigest: string;
	consentDigest: string;
	guestLeaseId: string;
	leaseExpiresAt?: string | undefined;
	claimBundleId: string;
	claimAtomicity: ClaimAtomicity;
	claimActionCount: number;
	earliestClaimDeadline?: string | undefined;
	placements: readonly GuestPlacementEvidence[];
	trustEvidenceRefs: readonly string[];
	conformanceRefs: readonly string[];
	sourceDisclosures?: readonly string[] | undefined;
	credentialCustody?: readonly string[] | undefined;
	wideningDisclosures?: readonly string[] | undefined;
	sponsorCostCapMinorUnits: number;
	cleanupPolicy: CleanupPolicy;
}

function requireString(value: JsonValue | undefined, field: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw fail(GUEST_CODE, `${field} must be a non-empty string`);
	}
	return value;
}

function requireDigest(value: JsonValue | undefined, field: string): string {
	const text = requireString(value, field);
	if (!DIGEST.test(text)) {
		throw fail(GUEST_CODE, `${field} must be a sha256:<hex64> digest`);
	}
	return text;
}

function requireInstant(value: JsonValue | undefined, field: string): string {
	const text = requireString(value, field);
	if (!INSTANT.test(text)) {
		throw fail(GUEST_CODE, `${field} must be an ISO-8601 instant`);
	}
	return text;
}

function optionalInstant(
	value: JsonValue | undefined,
	field: string,
): string | undefined {
	return value === undefined ? undefined : requireInstant(value, field);
}

function requireMember<T extends string>(
	value: JsonValue | undefined,
	allowed: readonly T[],
	field: string,
): T {
	// SAFETY: assertion required at this I/O or test boundary.
	if (!isJsonString(value) || !allowed.includes(value as T)) {
		throw fail(GUEST_CODE, `${field} must be one of ${allowed.join(" | ")}`);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as T;
}

function requireCount(value: JsonValue | undefined, field: string): number {
	if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
		throw fail(GUEST_CODE, `${field} must be a non-negative integer`);
	}
	return value;
}

function requireStrings(
	value: JsonValue | undefined,
	field: string,
	{ minimum }: { minimum: number },
): readonly string[] {
	if (!Array.isArray(value)) {
		throw fail(GUEST_CODE, `${field} must be an array of strings`);
	}
	if (value.length < minimum) {
		throw fail(
			GUEST_CODE,
			`${field} must contain at least ${minimum} entr${minimum === 1 ? "y" : "ies"}`,
		);
	}
	return value.map((entry, index) =>
		requireString(entry, `${field}[${index}]`),
	);
}

function optionalStrings(
	value: JsonValue | undefined,
	field: string,
): readonly string[] | undefined {
	return value === undefined
		? undefined
		: requireStrings(value, field, { minimum: 0 });
}

// Sponsor exposure is a promise to a provider's billing system, so it has to
// agree with how the deployment was bootstrapped: an anonymous deployment
// spends nothing of HoBo's, and a sponsored one must name what it may spend.
function assertSponsorBudgetMatchesBootstrap(
	bootstrapClass: BootstrapClass,
	capMinorUnits: number,
	field: string,
): void {
	if (bootstrapClass === "sponsor-backed" && capMinorUnits <= 0) {
		throw fail(
			SPONSOR_BUDGET_CODE,
			`${field} must be greater than zero for a sponsor-backed bootstrap`,
		);
	}
	if (bootstrapClass === "public-anonymous" && capMinorUnits !== 0) {
		throw fail(
			GUEST_CODE,
			`${field} must be zero for a public-anonymous bootstrap`,
		);
	}
}

export function parseGuestResolutionInput(
	value: JsonValue | undefined,
): GuestResolutionInput {
	if (value === null || !isJsonObject(value)) {
		throw fail(GUEST_CODE, "guest resolution input must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = value as JsonObject;
	const bootstrapClass = requireMember(
		raw.bootstrapClass,
		BOOTSTRAP_CLASSES,
		"guest.bootstrapClass",
	);
	const sponsorCostCapMinorUnits = requireCount(
		raw.sponsorCostCapMinorUnits,
		"guest.sponsorCostCapMinorUnits",
	);
	assertSponsorBudgetMatchesBootstrap(
		bootstrapClass,
		sponsorCostCapMinorUnits,
		"guest.sponsorCostCapMinorUnits",
	);
	const maxClaimActions = requireCount(
		raw.maxClaimActions,
		"guest.maxClaimActions",
	);
	if (maxClaimActions > MAX_CLAIM_ACTIONS) {
		throw fail(
			GUEST_CODE,
			`guest.maxClaimActions must not exceed ${MAX_CLAIM_ACTIONS}`,
		);
	}
	return {
		recipeId: requireString(raw.recipeId, "guest.recipeId"),
		topologyDigest: requireDigest(raw.topologyDigest, "guest.topologyDigest"),
		offerDigest: requireDigest(raw.offerDigest, "guest.offerDigest"),
		consentDigest: requireDigest(raw.consentDigest, "guest.consentDigest"),
		bootstrapClass,
		sponsorCostCapMinorUnits,
		maxClaimActions,
	};
}

export function parseGuestPlacementEvidence(
	value: JsonValue | undefined,
	index: number,
): GuestPlacementEvidence {
	if (value === null || !isJsonObject(value)) {
		throw fail(GUEST_CODE, `guest.placements[${index}] must be an object`);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = value as JsonObject;
	const field = `guest.placements[${index}]`;
	const realization = requireMember(
		raw.realization,
		REALIZATIONS,
		`${field}.realization`,
	);
	const connectivityRef =
		raw.connectivityRef === undefined
			? undefined
			: requireString(raw.connectivityRef, `${field}.connectivityRef`);
	// A bridge is only honest if it names the data plane it fronts; without a
	// connectivity implementation there is nothing to bridge through.
	if (realization === "bridge" && connectivityRef === undefined) {
		throw fail(
			GUEST_CODE,
			`${field}.connectivityRef is required for a bridge realization`,
		);
	}
	return {
		resourceId: requireString(raw.resourceId, `${field}.resourceId`),
		definitionId: requireString(raw.definitionId, `${field}.definitionId`),
		realization,
		runtimeModel: requireString(raw.runtimeModel, `${field}.runtimeModel`),
		capabilityProfileRefs: requireStrings(
			raw.capabilityProfileRefs,
			`${field}.capabilityProfileRefs`,
			{ minimum: 1 },
		),
		bindingProfileRefs: optionalStrings(
			raw.bindingProfileRefs,
			`${field}.bindingProfileRefs`,
		),
		connectivityRef,
		bootstrapClass: requireMember(
			raw.bootstrapClass,
			BOOTSTRAP_CLASSES,
			`${field}.bootstrapClass`,
		),
		claimMode: requireString(raw.claimMode, `${field}.claimMode`),
		creatorAuthorityAfterClaim: requireMember(
			raw.creatorAuthorityAfterClaim,
			CREATOR_AUTHORITIES_AFTER_CLAIM,
			`${field}.creatorAuthorityAfterClaim`,
		),
	};
}

export function parseGuestResolutionEvidence(
	value: JsonValue | undefined,
): GuestResolutionEvidence {
	if (value === null || !isJsonObject(value)) {
		throw fail(GUEST_CODE, "guest resolution evidence must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = value as JsonObject;
	const placementsRaw = raw.placements;
	if (!Array.isArray(placementsRaw) || placementsRaw.length === 0) {
		throw fail(
			GUEST_CODE,
			"guest.placements must contain at least one placement",
		);
	}
	const placements = placementsRaw.map((entry, index) =>
		parseGuestPlacementEvidence(entry, index),
	);
	const claimAtomicity = requireMember(
		raw.claimAtomicity,
		CLAIM_ATOMICITIES,
		"guest.claimAtomicity",
	);
	const claimActionCount = requireCount(
		raw.claimActionCount,
		"guest.claimActionCount",
	);
	const earliestClaimDeadline = optionalInstant(
		raw.earliestClaimDeadline,
		"guest.earliestClaimDeadline",
	);
	// A ceremony the human must perform needs a deadline they can be shown;
	// otherwise the UI has nothing to order the actions by and nothing to
	// count down to.
	if (claimActionCount > 0 && earliestClaimDeadline === undefined) {
		throw fail(
			GUEST_CODE,
			"guest.earliestClaimDeadline is required when the bundle has claim actions",
		);
	}
	if (claimAtomicity === "single-resource" && claimActionCount > 1) {
		throw fail(
			GUEST_CODE,
			"guest.claimAtomicity single-resource cannot carry more than one claim action",
		);
	}
	const sponsorCostCapMinorUnits = requireCount(
		raw.sponsorCostCapMinorUnits,
		"guest.sponsorCostCapMinorUnits",
	);
	const bootstrapClasses = new Set(
		placements.map((placement) => placement.bootstrapClass),
	);
	if (bootstrapClasses.has("sponsor-backed") && sponsorCostCapMinorUnits <= 0) {
		throw fail(
			SPONSOR_BUDGET_CODE,
			"guest.sponsorCostCapMinorUnits must be greater than zero when a placement is sponsor-backed",
		);
	}
	return {
		recipeId: requireString(raw.recipeId, "guest.recipeId"),
		topologyDigest: requireDigest(raw.topologyDigest, "guest.topologyDigest"),
		offerDigest: requireDigest(raw.offerDigest, "guest.offerDigest"),
		consentDigest: requireDigest(raw.consentDigest, "guest.consentDigest"),
		guestLeaseId: requireString(raw.guestLeaseId, "guest.guestLeaseId"),
		leaseExpiresAt: optionalInstant(raw.leaseExpiresAt, "guest.leaseExpiresAt"),
		claimBundleId: requireString(raw.claimBundleId, "guest.claimBundleId"),
		claimAtomicity,
		claimActionCount,
		earliestClaimDeadline,
		placements,
		trustEvidenceRefs: requireStrings(
			raw.trustEvidenceRefs,
			"guest.trustEvidenceRefs",
			{ minimum: 1 },
		),
		conformanceRefs: requireStrings(
			raw.conformanceRefs,
			"guest.conformanceRefs",
			{ minimum: 1 },
		),
		sourceDisclosures: optionalStrings(
			raw.sourceDisclosures,
			"guest.sourceDisclosures",
		),
		credentialCustody: optionalStrings(
			raw.credentialCustody,
			"guest.credentialCustody",
		),
		wideningDisclosures: optionalStrings(
			raw.wideningDisclosures,
			"guest.wideningDisclosures",
		),
		sponsorCostCapMinorUnits,
		cleanupPolicy: requireMember(
			raw.cleanupPolicy,
			CLEANUP_POLICIES,
			"guest.cleanupPolicy",
		),
	};
}

// The offer the human accepted must describe the deployment that was actually
// resolved. If either digest drifts, the consent on file was given for a
// different topology and the receipt must not be issued.
export function assertGuestEvidenceMatchesOffer(
	evidence: GuestResolutionEvidence,
	input: GuestResolutionInput,
): void {
	if (evidence.recipeId !== input.recipeId) {
		throw fail(
			OFFER_MISMATCH_CODE,
			"guest evidence recipeId does not match the accepted offer",
		);
	}
	if (evidence.topologyDigest !== input.topologyDigest) {
		throw fail(
			OFFER_MISMATCH_CODE,
			"guest evidence topologyDigest does not match the accepted offer",
		);
	}
	if (evidence.offerDigest !== input.offerDigest) {
		throw fail(
			OFFER_MISMATCH_CODE,
			"guest evidence offerDigest does not match the accepted offer",
		);
	}
	if (evidence.consentDigest !== input.consentDigest) {
		throw fail(
			OFFER_MISMATCH_CODE,
			"guest evidence consentDigest does not match the accepted offer",
		);
	}
	if (evidence.claimActionCount > input.maxClaimActions) {
		throw fail(
			OFFER_MISMATCH_CODE,
			"guest evidence requires more claim actions than the caller accepted",
		);
	}
	if (evidence.sponsorCostCapMinorUnits > input.sponsorCostCapMinorUnits) {
		throw fail(
			SPONSOR_BUDGET_CODE,
			"guest evidence exceeds the sponsor cost cap the caller accepted",
		);
	}
}
