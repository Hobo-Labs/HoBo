/**
 * The DeploymentOffer.
 *
 * An offer is compiled *before* any effectful provider call: it is the whole
 * proposal — providers, claims, deadlines, custody, cost exposure, and every
 * disclosed downgrade — rendered as canonical, signable bytes. Acceptance binds
 * to the offer, topology, resolution, and catalog digests together, so
 * substituting a provider or a recipe cannot reuse an old consent.
 *
 * It carries refs only. Never a secret, a claim URL, a token, or a connection
 * string; {@link assertOfferIsSecretFree} is the executable form of that rule.
 */

import type { ClaimAtomicity, Instant } from "@hobo/claims";
import { JWT_DETECTOR, PRIVATE_KEY_DETECTOR } from "@hobo/provider-redaction";
import type { CanonicalValue } from "@hobo/trust";
import { canonicalize, DIGEST_PATTERN, sha256Of } from "@hobo/trust";

import type { RecipeCompilationAccepted } from "./compile.js";
import type { RecipeId } from "./ids.js";
import type {
	CredentialCustody,
	SolutionRecipe,
	SourceDisclosure,
} from "./recipe.js";
import type { DeploymentRequest } from "./request.js";
import type { ResolvedResource } from "./topology.js";
import type { WideningKind } from "./widening.js";

// public-contract: versions signable deployment offers.
export const DEPLOYMENT_OFFER_SCHEMA_VERSION = "hobo.deployment-offer/v1";
// public-contract: versions consent records bound to deployment offers.
export const DEPLOYMENT_OFFER_ACCEPTANCE_SCHEMA_VERSION =
	"hobo.deployment-offer-acceptance/v1";

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferPlacement, built only by buildDeploymentOffer from an already-resolved topology; campId is genuinely optional here where the wire message uses an empty string.
export type OfferPlacement = {
	readonly placementId: string;
	readonly yardId: string;
	readonly campId?: string;
	readonly providerId: string;
	readonly primitive: string;
	readonly capabilityRef: string;
	readonly satisfiesProfileId: string;
	readonly productDefinitionId: string;
	readonly realization: string;
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferProvider, folded from the parsed recipe's yards rather than decoded from the wire.
export type OfferProvider = {
	readonly providerId: string;
	readonly sponsored: boolean;
	readonly resourceOnly: boolean;
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferClaimItem; deadlineMs is a branded Instant and its absence is meaningful, which int64 cannot express.
export type OfferClaimItem = {
	readonly claimId: string;
	readonly subjectRef: string;
	readonly providerId: string;
	readonly mode: string;
	readonly actionCount: number;
	readonly deadlineMs?: Instant;
	readonly creatorAuthorityAfterClaim: string;
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferClaimSummary; atomicity is the ClaimAtomicity union from @hobo/claims, which the wire message widens to a string.
export type OfferClaimSummary = {
	readonly actionCount: number;
	readonly providerCount: number;
	readonly atomicity: ClaimAtomicity;
	readonly earliestDeadlineMs?: Instant;
	readonly items: readonly OfferClaimItem[];
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferGuestLease; claimByMs is a branded Instant derived from the compile instant plus the recipe's relative lease offset.
export type OfferGuestLease = {
	readonly leaseId: string;
	readonly yardId: string;
	readonly bootstrapClass: string;
	readonly cleanupPolicy: string;
	readonly renewable: boolean;
	readonly claimByMs: Instant;
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferPortability, produced by the compiler as readonly arrays that the wire message projects as repeated fields.
export type OfferPortability = {
	readonly providerCount: number;
	readonly exportSupportedPlacements: readonly string[];
	readonly exportMissingPlacements: readonly string[];
	readonly migrationProfiles: readonly string[];
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferDegradationNotice; kind is the closed WideningKind union, which the wire message widens to a string.
export type OfferDegradationNotice = {
	readonly kind: WideningKind;
	readonly detail: string;
	readonly placementId?: string;
};

// parallel-type-allowed: the in-memory view of hobo.recipes.v1.OfferSignature; the payload digest is produced by sha256Of over canonical bytes, never decoded from the wire.
export type OfferSignature = {
	readonly algorithm: string;
	readonly keyId: string;
	readonly payloadDigest: string;
	readonly signature: string;
};

// parallel-type-allowed: the parse-don't-validate domain offer, constructed only by buildDeploymentOffer (which runs assertOfferIsSecretFree) and carrying branded RecipeId and Instant fields; hobo.recipes.v1.DeploymentOffer is its wire projection.
export type DeploymentOffer = {
	readonly schemaVersion: typeof DEPLOYMENT_OFFER_SCHEMA_VERSION;
	readonly offerId: string;
	readonly recipeId: RecipeId;
	readonly deploymentRef: string;
	readonly topologyDigest: string;
	readonly resolutionDigest: string;
	readonly catalogDigest: string;
	readonly profileRegistryDigest: string;
	readonly placements: readonly OfferPlacement[];
	readonly providers: readonly OfferProvider[];
	readonly claimSummary: OfferClaimSummary;
	readonly sourceDisclosure: SourceDisclosure;
	readonly credentialCustody: CredentialCustody;
	readonly requiredConsents: readonly string[];
	readonly sponsoredCostCapMinorUnits: number;
	readonly guestLeases: readonly OfferGuestLease[];
	readonly trustEvidenceRefs: readonly string[];
	readonly conformanceEvidenceRefs: readonly string[];
	readonly portability: OfferPortability;
	readonly degradationNotices: readonly OfferDegradationNotice[];
	readonly issuedAtMs: Instant;
	readonly expiresAtMs: Instant;
	readonly signature: OfferSignature;
};

/**
 * Signing port. This package implements no cryptography — it states what the
 * signer must answer and canonicalizes the bytes the signature is over.
 */
export type OfferSigner = {
	readonly algorithm: string;
	readonly keyId: string;
	sign(payloadDigest: string): string;
};

export class OfferSecretLeakError extends Error {
	readonly code = "OFFER_CONTAINS_SECRET" as const;
	readonly path: string;

	constructor(path: string, marker: string) {
		// The offending value is deliberately not interpolated: if this throws,
		// the value is by definition the thing that must not be logged.
		super(
			`deployment offer field ${path} matched the ${marker} shape; offers carry refs and non-secret metadata only`,
		);
		this.name = "OfferSecretLeakError";
		this.path = path;
	}
}

export class DeploymentOfferError extends Error {
	readonly code = "INVALID_DEPLOYMENT_OFFER" as const;

	constructor(message: string) {
		super(message);
		this.name = "DeploymentOfferError";
	}
}

/**
 * Shapes that must never reach an offer.
 *
 * URLs are banned outright rather than filtered: an offer references evidence,
 * products, and resources by id, so any URL in it is either a claim link, a
 * webhook, or a callback nobody should be able to replay from a stored offer.
 */
const FORBIDDEN_VALUE_PATTERNS: readonly {
	readonly name: string;
	readonly pattern: RegExp;
}[] = [
	{
		name: "connection-string",
		pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\//i,
	},
	{ name: "url", pattern: /\bhttps?:\/\//i },
	{ name: "websocket-url", pattern: /\bwss?:\/\//i },
	{ name: "private-key", pattern: PRIVATE_KEY_DETECTOR },
	{ name: "bearer-token", pattern: /\bbearer\s+\S+/i },
	{
		name: "api-key",
		pattern: /\b(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}/u,
	},
	{ name: "jwt", pattern: JWT_DETECTOR },
	{
		name: "credential-query-parameter",
		pattern: /[?&](?:token|code|secret|key|password|signature)=/i,
	},
];

function scanForSecrets(value: CanonicalValue, path: string): void {
	if (Object.prototype.toString.call(value) === "[object String]") {
		const text = String(value);
		for (const rule of FORBIDDEN_VALUE_PATTERNS) {
			if (rule.pattern.test(text))
				throw new OfferSecretLeakError(path, rule.name);
		}
		return;
	}
	if (Array.isArray(value)) {
		// SAFETY: assertion to `as readonly CanonicalValue[]).forE` is required at this boundary.
		(value as readonly CanonicalValue[]).forEach((entry, index) => {
			scanForSecrets(entry, `${path}[${index}]`);
		});
		return;
	}
	if (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	) {
		// SAFETY: assertion to `as { readonly [key: string]: CanonicalValue | undefined; }; fo` is required at this boundary.
		const record = value as {
			readonly [key: string]: CanonicalValue | undefined;
		};
		for (const key of Object.keys(record)) {
			const child = record[key];
			if (child === undefined) continue;
			scanForSecrets(child, `${path}.${key}`);
		}
	}
}

/** Throws if any offer value looks like a secret, URL, token, or DSN. */
export function assertOfferIsSecretFree(offer: DeploymentOffer): void {
	scanForSecrets(offerDigestBody(offer), "offer");
}

/** The bytes the signature is taken over: everything except the signature. */
export function offerPayloadBody(
	offer: Omit<DeploymentOffer, "signature">,
): CanonicalValue {
	return {
		schemaVersion: offer.schemaVersion,
		offerId: offer.offerId,
		recipeId: offer.recipeId,
		deploymentRef: offer.deploymentRef,
		topologyDigest: offer.topologyDigest,
		resolutionDigest: offer.resolutionDigest,
		catalogDigest: offer.catalogDigest,
		profileRegistryDigest: offer.profileRegistryDigest,
		placements: offer.placements.map((placement) => ({
			placementId: placement.placementId,
			yardId: placement.yardId,
			campId: placement.campId,
			providerId: placement.providerId,
			primitive: placement.primitive,
			capabilityRef: placement.capabilityRef,
			satisfiesProfileId: placement.satisfiesProfileId,
			productDefinitionId: placement.productDefinitionId,
			realization: placement.realization,
		})),
		providers: offer.providers.map((provider) => ({
			providerId: provider.providerId,
			sponsored: provider.sponsored,
			resourceOnly: provider.resourceOnly,
		})),
		claimSummary: {
			actionCount: offer.claimSummary.actionCount,
			providerCount: offer.claimSummary.providerCount,
			atomicity: offer.claimSummary.atomicity,
			earliestDeadlineMs: offer.claimSummary.earliestDeadlineMs,
			items: offer.claimSummary.items.map((item) => ({
				claimId: item.claimId,
				subjectRef: item.subjectRef,
				providerId: item.providerId,
				mode: item.mode,
				actionCount: item.actionCount,
				deadlineMs: item.deadlineMs,
				creatorAuthorityAfterClaim: item.creatorAuthorityAfterClaim,
			})),
		},
		sourceDisclosure: offer.sourceDisclosure,
		credentialCustody: offer.credentialCustody,
		requiredConsents: [...offer.requiredConsents],
		sponsoredCostCapMinorUnits: offer.sponsoredCostCapMinorUnits,
		guestLeases: offer.guestLeases.map((lease) => ({
			leaseId: lease.leaseId,
			yardId: lease.yardId,
			bootstrapClass: lease.bootstrapClass,
			cleanupPolicy: lease.cleanupPolicy,
			renewable: lease.renewable,
			claimByMs: lease.claimByMs,
		})),
		trustEvidenceRefs: [...offer.trustEvidenceRefs],
		conformanceEvidenceRefs: [...offer.conformanceEvidenceRefs],
		portability: {
			providerCount: offer.portability.providerCount,
			exportSupportedPlacements: [
				...offer.portability.exportSupportedPlacements,
			],
			exportMissingPlacements: [...offer.portability.exportMissingPlacements],
			migrationProfiles: [...offer.portability.migrationProfiles],
		},
		degradationNotices: offer.degradationNotices.map((notice) => ({
			kind: notice.kind,
			detail: notice.detail,
			placementId: notice.placementId,
		})),
		issuedAtMs: offer.issuedAtMs,
		expiresAtMs: offer.expiresAtMs,
	};
}

function offerDigestBody(offer: DeploymentOffer): CanonicalValue {
	return {
		payload: offerPayloadBody(offer),
		signature: {
			algorithm: offer.signature.algorithm,
			keyId: offer.signature.keyId,
			payloadDigest: offer.signature.payloadDigest,
			signature: offer.signature.signature,
		},
	};
}

/** Digest over the signed offer, including its signature envelope. */
export function offerDigest(offer: DeploymentOffer): string {
	return sha256Of(offerDigestBody(offer));
}

/** Canonical JSON bytes of an offer, for storage or transport. */
export function canonicalOfferBytes(offer: DeploymentOffer): string {
	return canonicalize(offerDigestBody(offer));
}

export type BuildDeploymentOfferInput = {
	readonly compilation: RecipeCompilationAccepted;
	readonly recipe: SolutionRecipe;
	readonly request: DeploymentRequest;
	readonly catalogDigest: string;
	readonly profileRegistryDigest: string;
	readonly issuedAtMs: Instant;
	readonly signer: OfferSigner;
};

/**
 * Render an accepted compilation as a signed offer.
 *
 * The offer id is derived from the resolution, the catalog, and the issue
 * instant rather than generated: two identical proposals issued at the same
 * instant are the same offer, and nothing here needs a random source.
 */
export function buildDeploymentOffer(
	input: BuildDeploymentOfferInput,
): DeploymentOffer {
	if (!Number.isInteger(input.issuedAtMs) || input.issuedAtMs <= 0) {
		throw new DeploymentOfferError(
			"issuedAtMs must be a positive integer instant",
		);
	}
	if (!DIGEST_PATTERN.test(input.catalogDigest)) {
		throw new DeploymentOfferError(
			"catalogDigest must be a lowercase sha256:<hex> digest",
		);
	}
	if (!DIGEST_PATTERN.test(input.profileRegistryDigest)) {
		throw new DeploymentOfferError(
			"profileRegistryDigest must be a lowercase sha256:<hex> digest",
		);
	}

	const { compilation, recipe, request } = input;

	const placements: OfferPlacement[] = [];
	for (const yard of compilation.topology.yards) {
		const rows: readonly {
			readonly resource: ResolvedResource;
			readonly campId?: string;
		}[] = [
			...yard.resources.map((resource) => ({ resource })),
			...yard.camps.flatMap((camp) =>
				camp.resources.map((resource) => ({ resource, campId: camp.campId })),
			),
		];
		for (const row of rows) {
			placements.push({
				placementId: row.resource.placementId,
				yardId: yard.yardId,
				...(row.campId !== undefined ? { campId: row.campId } : undefined),
				providerId: yard.providerId,
				primitive: row.resource.primitive,
				capabilityRef: row.resource.capabilityRef,
				satisfiesProfileId: row.resource.satisfiesProfileId,
				productDefinitionId: row.resource.productDefinitionId,
				realization: row.resource.realization,
			});
		}
	}
	placements.sort((a, b) => a.placementId.localeCompare(b.placementId));

	const providerRows = new Map<string, OfferProvider>();
	for (const yard of recipe.yards) {
		const existing = providerRows.get(yard.providerId);
		providerRows.set(yard.providerId, {
			providerId: yard.providerId,
			sponsored: (existing?.sponsored ?? false) || yard.sponsored,
			// A provider is only reported resource-only when every Yard it owns
			// in this deployment is.
			resourceOnly: (existing?.resourceOnly ?? true) && yard.resourceOnly,
		});
	}

	const offerId = `offer/${sha256Of({
		resolutionDigest: compilation.resolutionDigest,
		catalogDigest: input.catalogDigest,
		deploymentRef: request.deploymentRef,
		issuedAtMs: input.issuedAtMs,
	}).slice("sha256:".length)}`;

	const unsigned: Omit<DeploymentOffer, "signature"> = {
		schemaVersion: DEPLOYMENT_OFFER_SCHEMA_VERSION,
		offerId,
		recipeId: recipe.id,
		deploymentRef: request.deploymentRef,
		topologyDigest: compilation.topologyDigest,
		resolutionDigest: compilation.resolutionDigest,
		catalogDigest: input.catalogDigest,
		profileRegistryDigest: input.profileRegistryDigest,
		placements,
		providers: [...providerRows.values()].sort((a, b) =>
			a.providerId.localeCompare(b.providerId),
		),
		claimSummary: {
			actionCount: compilation.claims.actionCount,
			providerCount: compilation.claims.providerCount,
			atomicity: compilation.claims.atomicity,
			...(compilation.claims.earliestDeadlineMs !== undefined
				? { earliestDeadlineMs: compilation.claims.earliestDeadlineMs }
				: undefined),
			items: compilation.claims.items.map((item) => ({
				claimId: item.claimId,
				subjectRef: item.subjectRef,
				providerId: item.providerId,
				mode: item.mode,
				actionCount: item.actionCount,
				...(item.deadlineMs !== undefined
					? { deadlineMs: item.deadlineMs }
					: undefined),
				creatorAuthorityAfterClaim: item.creatorAuthorityAfterClaim,
			})),
		},
		sourceDisclosure: recipe.bootstrap.sourceDisclosure,
		credentialCustody: recipe.delivers.credentialCustody,
		requiredConsents: recipe.bootstrap.requiredConsents,
		sponsoredCostCapMinorUnits: compilation.sponsoredCostMinorUnits,
		guestLeases: compilation.guestLeases.map((lease) => ({
			leaseId: lease.leaseId,
			yardId: lease.yardId,
			bootstrapClass: lease.bootstrapClass,
			cleanupPolicy: lease.cleanupPolicy,
			renewable: lease.renewable,
			claimByMs: lease.claimByMs,
		})),
		trustEvidenceRefs: compilation.trustEvidenceRefs,
		conformanceEvidenceRefs: compilation.conformanceEvidenceRefs,
		portability: compilation.portability,
		// Every permitted widening is disclosed. A downgrade that policy allowed
		// but the offer hid would defeat the whole gate.
		degradationNotices: compilation.widenings.map((notice) => ({
			kind: notice.kind,
			detail: notice.detail,
			...(notice.placementId !== undefined
				? { placementId: notice.placementId }
				: undefined),
		})),
		issuedAtMs: input.issuedAtMs,
		expiresAtMs: input.issuedAtMs + recipe.bootstrap.offerTtlMs,
	};

	const payloadDigest = sha256Of(offerPayloadBody(unsigned));
	const offer: DeploymentOffer = {
		...unsigned,
		signature: {
			algorithm: input.signer.algorithm,
			keyId: input.signer.keyId,
			payloadDigest,
			signature: input.signer.sign(payloadDigest),
		},
	};
	// Fail loudly at construction rather than at disclosure time.
	assertOfferIsSecretFree(offer);
	return offer;
}

// parallel-type-allowed: the parse-don't-validate domain acceptance, constructed only by acceptOffer so that acceptanceDigest is always the digest of this exact body; hobo.recipes.v1.DeploymentOfferAcceptance is its wire projection.
export type DeploymentOfferAcceptance = {
	readonly schemaVersion: typeof DEPLOYMENT_OFFER_ACCEPTANCE_SCHEMA_VERSION;
	readonly offerId: string;
	readonly offerDigest: string;
	readonly topologyDigest: string;
	readonly resolutionDigest: string;
	readonly catalogDigest: string;
	readonly acceptedAtMs: Instant;
	readonly subjectRef: string;
	readonly consents: readonly string[];
	readonly acceptanceDigest: string;
};

export type AcceptOfferInput = {
	readonly offer: DeploymentOffer;
	readonly subjectRef: string;
	readonly acceptedAtMs: Instant;
	readonly consents: readonly string[];
};

function acceptanceDigestBody(
	acceptance: Omit<DeploymentOfferAcceptance, "acceptanceDigest">,
): CanonicalValue {
	return {
		schemaVersion: acceptance.schemaVersion,
		offerId: acceptance.offerId,
		offerDigest: acceptance.offerDigest,
		topologyDigest: acceptance.topologyDigest,
		resolutionDigest: acceptance.resolutionDigest,
		catalogDigest: acceptance.catalogDigest,
		acceptedAtMs: acceptance.acceptedAtMs,
		subjectRef: acceptance.subjectRef,
		consents: [...acceptance.consents],
	};
}

/** Bind a consent to this exact offer, topology, resolution, and catalog. */
export function acceptOffer(
	input: AcceptOfferInput,
): DeploymentOfferAcceptance {
	if (!Number.isInteger(input.acceptedAtMs) || input.acceptedAtMs <= 0) {
		throw new DeploymentOfferError(
			"acceptedAtMs must be a positive integer instant",
		);
	}
	const body = {
		schemaVersion: DEPLOYMENT_OFFER_ACCEPTANCE_SCHEMA_VERSION,
		offerId: input.offer.offerId,
		offerDigest: offerDigest(input.offer),
		topologyDigest: input.offer.topologyDigest,
		resolutionDigest: input.offer.resolutionDigest,
		catalogDigest: input.offer.catalogDigest,
		acceptedAtMs: input.acceptedAtMs,
		subjectRef: input.subjectRef,
		consents: [...new Set(input.consents)].sort((a, b) => a.localeCompare(b)),
	} as const;
	return { ...body, acceptanceDigest: sha256Of(acceptanceDigestBody(body)) };
}

export const ACCEPTANCE_REJECTION_CODES = [
	"ACCEPTANCE_DIGEST_MISMATCH",
	"CATALOG_DIGEST_MISMATCH",
	"CONSENT_MISSING",
	"OFFER_DIGEST_MISMATCH",
	"OFFER_EXPIRED",
	"OFFER_ID_MISMATCH",
	"RESOLUTION_DIGEST_MISMATCH",
	"TOPOLOGY_DIGEST_MISMATCH",
] as const;

export type AcceptanceRejectionCode =
	(typeof ACCEPTANCE_REJECTION_CODES)[number];

export type AcceptanceRejection = {
	readonly code: AcceptanceRejectionCode;
	readonly detail: string;
};

export type AcceptanceVerification = {
	readonly valid: boolean;
	readonly reasons: readonly AcceptanceRejection[];
};

export type VerifyAcceptanceInput = {
	readonly acceptance: DeploymentOfferAcceptance;
	readonly offer: DeploymentOffer;
	/** The catalog digest at the moment of provisioning, not of offering. */
	readonly catalogDigest: string;
	readonly nowMs: Instant;
};

/**
 * Check a stored acceptance against the offer and the *current* catalog.
 *
 * The catalog digest is passed separately on purpose: a provider substituted
 * after the offer was signed changes it, and that must invalidate the consent
 * rather than silently ride on it.
 */
export function verifyAcceptance(
	input: VerifyAcceptanceInput,
): AcceptanceVerification {
	const reasons: AcceptanceRejection[] = [];
	const { acceptance, offer } = input;

	if (acceptance.offerId !== offer.offerId) {
		reasons.push({
			code: "OFFER_ID_MISMATCH",
			detail: `acceptance is for offer ${acceptance.offerId}, not ${offer.offerId}`,
		});
	}
	const recomputedOffer = offerDigest(offer);
	if (acceptance.offerDigest !== recomputedOffer) {
		reasons.push({
			code: "OFFER_DIGEST_MISMATCH",
			detail: `the accepted offer digested to ${acceptance.offerDigest}; this offer digests to ${recomputedOffer}`,
		});
	}
	if (acceptance.topologyDigest !== offer.topologyDigest) {
		reasons.push({
			code: "TOPOLOGY_DIGEST_MISMATCH",
			detail: "the resolved topology changed since the offer was accepted",
		});
	}
	if (acceptance.resolutionDigest !== offer.resolutionDigest) {
		reasons.push({
			code: "RESOLUTION_DIGEST_MISMATCH",
			detail: "the resolution changed since the offer was accepted",
		});
	}
	if (acceptance.catalogDigest !== input.catalogDigest) {
		reasons.push({
			code: "CATALOG_DIGEST_MISMATCH",
			detail: `the product catalog moved from ${acceptance.catalogDigest} to ${input.catalogDigest}; substituting a provider requires a new consent`,
		});
	}
	const recomputedAcceptance = sha256Of(acceptanceDigestBody(acceptance));
	if (acceptance.acceptanceDigest !== recomputedAcceptance) {
		reasons.push({
			code: "ACCEPTANCE_DIGEST_MISMATCH",
			detail: "the acceptance record does not digest to its recorded value",
		});
	}
	if (input.nowMs >= offer.expiresAtMs) {
		reasons.push({
			code: "OFFER_EXPIRED",
			detail: `the offer expired at ${offer.expiresAtMs}`,
		});
	}
	const given = new Set(acceptance.consents);
	for (const consent of offer.requiredConsents) {
		if (!given.has(consent)) {
			reasons.push({
				code: "CONSENT_MISSING",
				detail: `required consent ${consent} was not given`,
			});
		}
	}

	return {
		valid: reasons.length === 0,
		reasons: reasons.sort(
			(a, b) =>
				a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail),
		),
	};
}
