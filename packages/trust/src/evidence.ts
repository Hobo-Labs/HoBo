/**
 * Trust evidence: what was actually tested against a provider adapter, when,
 * and by whom.
 *
 * Evidence is a claim about the world, so it is only useful when it is signed,
 * dated, and cites the sources it was derived from. Everything here is data —
 * verification is a port ({@link EvidenceVerifier}), never a crypto
 * implementation invented in this package.
 */
import type {
	CreatorAuthorityAfterClaim,
	ProviderClass,
	RealizationKind,
} from "@hobo/capability-profiles";

import { type CanonicalValue, DIGEST_PATTERN, sha256Of } from "./canonical.js";

// public-contract: signed trust evidence schema identifier used across adapter boundaries.
export const TRUST_EVIDENCE_SCHEMA_VERSION = "hobo.trust-evidence/v1";

/** A check outcome. `unknown` is deliberately not a pass. */
export type EvidenceCheckOutcome = "pass" | "fail" | "unknown";

// parallel-type-allowed: the source citation as authored, whose https-only URL and dated checkedAt are established by parseTrustEvidence; hobo.trust.v1.EvidenceSourceRef is its wire projection.
export type EvidenceSourceRef = {
	readonly url: string;
	/** ISO date (`YYYY-MM-DD`) a human checked the source. */
	readonly checkedAt: string;
	readonly note?: string;
};

/**
 * Check keys the trust requirement understands directly. Additional keys are
 * allowed and can be demanded through `requiredChecks`.
 */
export const STANDARD_TRUST_CHECKS = {
	officialBootstrapContract: "bootstrap.official-contract",
	documentedClaimContract: "claim.documented-contract",
	claimVerification: "claim.verification",
	credentialRotation: "credential.rotation",
	exportProfile: "portability.export-profile",
	standardBinding: "portability.standard-binding",
	conformanceSuite: "conformance.suite",
} as const;

export type StandardTrustCheck =
	(typeof STANDARD_TRUST_CHECKS)[keyof typeof STANDARD_TRUST_CHECKS];

export type TrustEvidenceInput = {
	readonly schemaVersion: typeof TRUST_EVIDENCE_SCHEMA_VERSION;
	readonly providerId: string;
	readonly productDefinitionId: string;
	readonly adapterVersion: string;
	readonly providerClass: ProviderClass;
	/** Epoch milliseconds the adapter was exercised. */
	readonly testedAt: number;
	/** Epoch milliseconds after which this evidence is no longer usable. */
	readonly expiresAt: number;
	readonly checks: Readonly<Record<string, EvidenceCheckOutcome>>;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	/** Human actions the observed claim flow required. */
	readonly claimActionCount: number;
	/** Realization kinds the adapter was observed to use. */
	readonly realizations?: readonly RealizationKind[];
	/** Whether the observed bootstrap path spent HoBo sponsor budget. */
	readonly sponsorBacked?: boolean;
	readonly evidenceDigest: string;
	readonly signature: string;
	readonly sourceRefs: readonly EvidenceSourceRef[];
};

declare const trustEvidenceBrand: unique symbol;

/** Parsed evidence. Construct only through {@link parseTrustEvidence}. */
export type TrustEvidence = Omit<
	TrustEvidenceInput,
	"realizations" | "sponsorBacked"
> & {
	readonly realizations?: readonly RealizationKind[];
	readonly sponsorBacked?: boolean;
	readonly [trustEvidenceBrand]: "TrustEvidence";
};

export class TrustEvidenceError extends Error {
	readonly code = "INVALID_TRUST_EVIDENCE" as const;

	constructor(message: string) {
		super(message);
		this.name = "TrustEvidenceError";
	}
}

const CHECK_OUTCOMES: readonly EvidenceCheckOutcome[] = [
	"pass",
	"fail",
	"unknown",
];
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z)?$/u;
const REALIZATIONS: readonly RealizationKind[] = ["native", "pack", "bridge"];

function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TrustEvidenceError(`${field} must be a non-empty string`);
	}
	if (value !== value.trim()) {
		throw new TrustEvidenceError(
			`${field} must not have surrounding whitespace`,
		);
	}
	return value;
}

function requireInstant(value: unknown, field: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value)
	) {
		throw new TrustEvidenceError(
			`${field} must be an integer epoch-millisecond instant`,
		);
	}
	return value;
}

/**
 * The body a digest is taken over: everything except the digest and the
 * signature, which are statements *about* the body.
 */
export function evidenceDigestBody(
	input: TrustEvidenceInput | TrustEvidence,
): CanonicalValue {
	return {
		schemaVersion: input.schemaVersion,
		providerId: input.providerId,
		productDefinitionId: input.productDefinitionId,
		adapterVersion: input.adapterVersion,
		providerClass: input.providerClass,
		testedAt: input.testedAt,
		expiresAt: input.expiresAt,
		checks: sortedChecks(input.checks),
		creatorAuthorityAfterClaim: input.creatorAuthorityAfterClaim,
		claimActionCount: input.claimActionCount,
		realizations:
			input.realizations === undefined
				? undefined
				: [...input.realizations].sort(),
		sponsorBacked: input.sponsorBacked,
		sourceRefs: sortedSources(input.sourceRefs).map((source) => ({
			url: source.url,
			checkedAt: source.checkedAt,
			note: source.note,
		})),
	};
}

export function computeEvidenceDigest(
	input: TrustEvidenceInput | TrustEvidence,
): string {
	return sha256Of(evidenceDigestBody(input));
}

function sortedChecks(
	checks: Readonly<Record<string, EvidenceCheckOutcome>>,
): Readonly<Record<string, EvidenceCheckOutcome>> {
	const entries = Object.keys(checks)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((key) => [key, checks[key] as EvidenceCheckOutcome] as const);
	return Object.fromEntries(entries);
}

function sortedSources(
	sources: readonly EvidenceSourceRef[],
): readonly EvidenceSourceRef[] {
	return [...sources].sort(
		(a, b) =>
			a.url.localeCompare(b.url) || a.checkedAt.localeCompare(b.checkedAt),
	);
}

/**
 * Parse-don't-validate boundary for evidence.
 *
 * A malformed record never becomes "evidence with some missing fields": it is
 * not evidence at all, and {@link evaluateTrust} treats an unparseable record
 * exactly like an absent one.
 */
export function parseTrustEvidence(input: TrustEvidenceInput): TrustEvidence {
	if (input.schemaVersion !== TRUST_EVIDENCE_SCHEMA_VERSION) {
		throw new TrustEvidenceError(
			`unsupported trust evidence schemaVersion ${String(input.schemaVersion)}`,
		);
	}
	const providerId = requireText(input.providerId, "providerId");
	if (!PROVIDER_ID.test(providerId)) {
		throw new TrustEvidenceError(
			`providerId ${JSON.stringify(providerId)} must be a lowercase dns-style label`,
		);
	}
	const productDefinitionId = requireText(
		input.productDefinitionId,
		"productDefinitionId",
	);
	const adapterVersion = requireText(input.adapterVersion, "adapterVersion");
	const testedAt = requireInstant(input.testedAt, "testedAt");
	const expiresAt = requireInstant(input.expiresAt, "expiresAt");
	if (expiresAt <= testedAt) {
		throw new TrustEvidenceError("expiresAt must be after testedAt");
	}

	const checkKeys = Object.keys(input.checks);
	if (checkKeys.length === 0) {
		throw new TrustEvidenceError("evidence must record at least one check");
	}
	for (const key of checkKeys) {
		requireText(key, "check key");
		const outcome = input.checks[key];
		if (outcome === undefined || !CHECK_OUTCOMES.includes(outcome)) {
			throw new TrustEvidenceError(
				`check ${JSON.stringify(key)} outcome must be pass, fail, or unknown`,
			);
		}
	}

	if (
		!Number.isInteger(input.claimActionCount) ||
		input.claimActionCount < 0 ||
		input.claimActionCount > 32
	) {
		throw new TrustEvidenceError(
			"claimActionCount must be an integer between 0 and 32",
		);
	}

	if (input.realizations !== undefined) {
		for (const realization of input.realizations) {
			if (!REALIZATIONS.includes(realization)) {
				throw new TrustEvidenceError(
					`unknown realization kind ${JSON.stringify(realization)}`,
				);
			}
		}
	}

	const signature = requireText(input.signature, "signature");
	const evidenceDigest = requireText(input.evidenceDigest, "evidenceDigest");
	if (!DIGEST_PATTERN.test(evidenceDigest)) {
		throw new TrustEvidenceError(
			"evidenceDigest must be a lowercase sha256:<hex> digest",
		);
	}

	if (input.sourceRefs.length === 0) {
		throw new TrustEvidenceError("evidence must cite at least one source");
	}
	for (const source of input.sourceRefs) {
		const url = requireText(source.url, "sourceRefs[].url");
		if (!url.startsWith("https://")) {
			throw new TrustEvidenceError("evidence sources must be https URLs");
		}
		const checkedAt = requireText(source.checkedAt, "sourceRefs[].checkedAt");
		if (!ISO_DATE.test(checkedAt)) {
			throw new TrustEvidenceError(
				"evidence source checkedAt must be an ISO date a human verified",
			);
		}
	}

	return {
		schemaVersion: TRUST_EVIDENCE_SCHEMA_VERSION,
		providerId,
		productDefinitionId,
		adapterVersion,
		providerClass: input.providerClass,
		testedAt,
		expiresAt,
		checks: sortedChecks(input.checks),
		creatorAuthorityAfterClaim: input.creatorAuthorityAfterClaim,
		claimActionCount: input.claimActionCount,
		...(input.realizations !== undefined
			? { realizations: [...input.realizations].sort() }
			: {}),
		...(input.sponsorBacked !== undefined
			? { sponsorBacked: input.sponsorBacked }
			: {}),
		evidenceDigest,
		signature,
		sourceRefs: sortedSources(input.sourceRefs),
		// The brand is a type-level witness that this value passed the parser.
	} as unknown as TrustEvidence;
}

export function tryParseTrustEvidence(
	input: TrustEvidenceInput,
): TrustEvidence | undefined {
	try {
		return parseTrustEvidence(input);
	} catch {
		return undefined;
	}
}
