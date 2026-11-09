/**
 * Turning a conformance run into trust evidence.
 *
 * `@hobo/trust` owns what evidence *is* and how it is evaluated; this module
 * owns the narrow job of projecting suite reports into that shape without ever
 * improving the result. Three rules hold the whole thing up:
 *
 * 1. **Nothing is upgraded.** A check that was skipped, unsupported, or never
 *    written stays `unknown`. Aggregation is worst-wins, in both directions.
 * 2. **Nothing sensitive travels.** The artifact is scanned before it leaves
 *    this module, and a credential-shaped string anywhere inside it is a hard
 *    error rather than a redaction.
 * 3. **Everything expires.** Evidence carries the instant it was taken and the
 *    instant it stops counting, so selection can fail closed without asking
 *    anyone whether the provider has changed since.
 */

import type {
	CreatorAuthorityAfterClaim,
	ProviderClass,
} from "@hobo/capability-profiles";
import {
	computeEvidenceDigest,
	DIGEST_PATTERN,
	type EvidenceCheckOutcome,
	type EvidenceSourceRef,
	type EvidenceVerifier,
	parseTrustEvidence,
	STANDARD_TRUST_CHECKS,
	sha256Of,
	TRUST_EVIDENCE_SCHEMA_VERSION,
	type TrustEvidence,
} from "@hobo/trust";

import { BINDING_CHECKS } from "../suites/anonymous/binding.js";
import { BOOTSTRAP_CHECKS } from "../suites/anonymous/bootstrap.js";
import { CLAIM_CHECKS } from "../suites/anonymous/claim.js";
import { worst } from "../suites/anonymous/harness.js";
import { MIGRATION_CHECKS } from "../suites/anonymous/migration.js";
import type { AnonymousConformanceReport } from "../suites/anonymous/types.js";

export interface EvidenceCheckBag {
	[check: string]: EvidenceCheckOutcome;
}

export interface SelectionEvidenceFacts {
	readonly evidenceExpiresAtMs: number;
	readonly evidenceSignatureValid: boolean;
}

// public-contract: versions portable anonymous-provider trust evidence.
export const ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA =
	"hobo.conformance.anonymous-trust-evidence/v1" as const;

/** Default validity of a live run's evidence: 30 days, matching the default trust policy. */
export const DEFAULT_EVIDENCE_FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Longest window an operator may configure. Evidence that never ages is not evidence. */
export const MAXIMUM_EVIDENCE_FRESHNESS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** The check recording whether the run cleaned up after itself. */
// public-contract: stable check identifier consumed by trust policies.
export const CLEANUP_CHECK = "lifecycle.cleanup";

/** Signing is a port. This package implements no cryptography. */
export type EvidenceSigner = {
	/** Identifies the signing key, so a verdict can say who vouched. */
	readonly id: string;
	sign(digest: string): string;
};

export type EvidenceProvenance = {
	readonly adapterVersion: string;
	/** Digest of the Resource Definition this evidence describes. */
	readonly productDefinitionDigest: string;
	/** ISO date a human last read the provider's documented contract. */
	readonly providerDocsCheckedAt: string;
	readonly runTag: string;
	readonly signerId: string;
	readonly suiteIds: readonly string[];
};

// domain-view: parse-dont-validate parsed/derived type; its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface AnonymousTrustEvidenceArtifact {
	readonly schema: typeof ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA;
	readonly provenance: EvidenceProvenance;
	readonly evidence: TrustEvidence;
	readonly artifactDigest: string;
	readonly signature: string;
}

export class LiveEvidenceError extends Error {
	readonly code:
		| "EVIDENCE_CONTAINS_SECRET"
		| "EVIDENCE_UPGRADES_UNKNOWN"
		| "EVIDENCE_WINDOW_INVALID"
		| "EVIDENCE_PROVENANCE_INVALID";

	constructor(
		code:
			| "EVIDENCE_CONTAINS_SECRET"
			| "EVIDENCE_UPGRADES_UNKNOWN"
			| "EVIDENCE_WINDOW_INVALID"
			| "EVIDENCE_PROVENANCE_INVALID",
		message: string,
	) {
		super(message);
		this.name = "LiveEvidenceError";
		this.code = code;
	}
}

export type LiveEvidenceInput = {
	readonly providerId: string;
	readonly productDefinitionId: string;
	readonly productDefinitionDigest: string;
	readonly adapterVersion: string;
	readonly providerClass: ProviderClass;
	readonly providerDocsCheckedAt: string;
	readonly runTag: string;
	/** Injected instant the adapter was exercised. Never a clock read here. */
	readonly testedAtMs: number;
	readonly freshnessWindowMs?: number;
	readonly reports: readonly AnonymousConformanceReport[];
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimActionCount: number;
	readonly sourceRefs: readonly EvidenceSourceRef[];
	readonly signer: EvidenceSigner;
	/** Extra checks the runner decided, such as cleanup. */
	readonly additionalChecks?: Readonly<Record<string, EvidenceCheckOutcome>>;
};

/**
 * Fold every suite's per-check outcome into one flat map.
 *
 * Two suites deciding the same check key combine worst-wins, which is why a
 * provider cannot dilute a failure by adding a second, friendlier suite.
 */
export function checksFromReports(
	reports: readonly AnonymousConformanceReport[],
): EvidenceCheckBag {
	const checks: EvidenceCheckBag = {};
	for (const report of reports) {
		for (const [check, outcome] of Object.entries(report.checks)) {
			const current = checks[check];
			checks[check] = current === undefined ? outcome : worst(current, outcome);
		}
	}
	return checks;
}

/**
 * Project the dimension's checks onto the vocabulary `@hobo/trust` evaluates.
 *
 * The standard keys are what `evaluateTrust` and `TrustRequirement` speak, so
 * without this bridge a perfect live run would still read as "no evidence" to
 * the trust gate.
 */
export function standardTrustChecksFrom(
	reports: readonly AnonymousConformanceReport[],
): EvidenceCheckBag {
	const detailed = checksFromReports(reports);
	const look = (check: string): EvidenceCheckOutcome =>
		detailed[check] ?? "unknown";

	const suiteOutcome = Object.values(detailed).reduce<EvidenceCheckOutcome>(
		(accumulator, outcome) => worst(accumulator, outcome),
		"pass",
	);

	return {
		[STANDARD_TRUST_CHECKS.officialBootstrapContract]: worst(
			look(BOOTSTRAP_CHECKS.advertisedClassHolds),
			look(BOOTSTRAP_CHECKS.consentBeforeEffect),
		),
		[STANDARD_TRUST_CHECKS.documentedClaimContract]: look(
			CLAIM_CHECKS.callbackIsNotOwnership,
		),
		[STANDARD_TRUST_CHECKS.claimVerification]: look(
			CLAIM_CHECKS.independentVerification,
		),
		[STANDARD_TRUST_CHECKS.credentialRotation]: worst(
			worst(
				look(CLAIM_CHECKS.obligationsGateCompletion),
				look(CLAIM_CHECKS.preClaimCredentialRevoked),
			),
			look(BINDING_CHECKS.rotationPreservesIdentity),
		),
		[STANDARD_TRUST_CHECKS.exportProfile]: worst(
			look(MIGRATION_CHECKS.exportIntegrityDigest),
			look(MIGRATION_CHECKS.importVerifiedAtDistinctDestination),
		),
		[STANDARD_TRUST_CHECKS.standardBinding]: worst(
			look(BINDING_CHECKS.roundTrip),
			look(BINDING_CHECKS.credentialsAreRefs),
		),
		[STANDARD_TRUST_CHECKS.conformanceSuite]: suiteOutcome,
	};
}

/**
 * Build the signed, sanitized artifact.
 *
 * The evidence body and the artifact are signed separately by the same signer:
 * the first is what `@hobo/trust` verifies, the second binds the provenance
 * (adapter version, product-definition digest, docs date, run tag) that the
 * evidence schema has no field for.
 */
export function emitAnonymousTrustEvidence(
	input: LiveEvidenceInput,
): AnonymousTrustEvidenceArtifact {
	const freshnessWindowMs =
		input.freshnessWindowMs ?? DEFAULT_EVIDENCE_FRESHNESS_WINDOW_MS;
	if (
		!Number.isInteger(freshnessWindowMs) ||
		freshnessWindowMs <= 0 ||
		freshnessWindowMs > MAXIMUM_EVIDENCE_FRESHNESS_WINDOW_MS
	) {
		throw new LiveEvidenceError(
			"EVIDENCE_WINDOW_INVALID",
			`freshness window must be between 1ms and ${MAXIMUM_EVIDENCE_FRESHNESS_WINDOW_MS}ms`,
		);
	}
	if (!DIGEST_PATTERN.test(input.productDefinitionDigest)) {
		throw new LiveEvidenceError(
			"EVIDENCE_PROVENANCE_INVALID",
			"productDefinitionDigest must be a lowercase sha256:<hex> digest",
		);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.providerDocsCheckedAt)) {
		throw new LiveEvidenceError(
			"EVIDENCE_PROVENANCE_INVALID",
			"providerDocsCheckedAt must be the YYYY-MM-DD date a human checked the docs",
		);
	}

	const checks: EvidenceCheckBag = {
		...checksFromReports(input.reports),
		...standardTrustChecksFrom(input.reports),
		...input.additionalChecks,
	};
	assertNoUpgradedUnknowns(input.reports, checks);

	const evidenceInput = {
		schemaVersion: TRUST_EVIDENCE_SCHEMA_VERSION,
		providerId: input.providerId,
		productDefinitionId: input.productDefinitionId,
		adapterVersion: input.adapterVersion,
		providerClass: input.providerClass,
		testedAt: input.testedAtMs,
		expiresAt: input.testedAtMs + freshnessWindowMs,
		checks,
		creatorAuthorityAfterClaim: input.creatorAuthorityAfterClaim,
		claimActionCount: input.claimActionCount,
		sourceRefs: input.sourceRefs,
	} as const;

	const evidenceDigest = computeEvidenceDigest({
		...evidenceInput,
		evidenceDigest: "sha256:0",
		signature: "",
	});
	const evidence = parseTrustEvidence({
		...evidenceInput,
		evidenceDigest,
		signature: input.signer.sign(evidenceDigest),
	});

	const provenance: EvidenceProvenance = {
		adapterVersion: input.adapterVersion,
		productDefinitionDigest: input.productDefinitionDigest,
		providerDocsCheckedAt: input.providerDocsCheckedAt,
		runTag: input.runTag,
		signerId: input.signer.id,
		suiteIds: input.reports.map((report) => report.suiteId).sort(),
	};
	const artifactDigest = sha256Of({
		schema: ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA,
		evidenceDigest: evidence.evidenceDigest,
		adapterVersion: provenance.adapterVersion,
		productDefinitionDigest: provenance.productDefinitionDigest,
		providerDocsCheckedAt: provenance.providerDocsCheckedAt,
		runTag: provenance.runTag,
		signerId: provenance.signerId,
		suiteIds: [...provenance.suiteIds],
	});

	const artifact: AnonymousTrustEvidenceArtifact = Object.freeze({
		schema: ANONYMOUS_EVIDENCE_ARTIFACT_SCHEMA,
		provenance: Object.freeze(provenance),
		evidence,
		artifactDigest,
		signature: input.signer.sign(artifactDigest),
	});

	assertSanitized(artifact);
	return artifact;
}

/**
 * Refuse to emit an artifact that claims more than the run proved.
 *
 * The runner builds `checks` from several sources, so this re-derives the
 * per-report truth and compares. A caller passing `additionalChecks` cannot use
 * it to overwrite a suite's `unknown` with a `pass`.
 */
export function assertNoUpgradedUnknowns(
	reports: readonly AnonymousConformanceReport[],
	checks: Readonly<Record<string, EvidenceCheckOutcome>>,
): void {
	const observed = checksFromReports(reports);
	for (const [check, outcome] of Object.entries(observed)) {
		const emitted = checks[check];
		if (emitted === undefined) {
			throw new LiveEvidenceError(
				"EVIDENCE_UPGRADES_UNKNOWN",
				`check ${check} was decided by a suite but dropped from the artifact`,
			);
		}
		if (emitted !== outcome) {
			throw new LiveEvidenceError(
				"EVIDENCE_UPGRADES_UNKNOWN",
				`check ${check} was ${outcome} in the suite report but ${emitted} in the artifact`,
			);
		}
	}
	for (const report of reports) {
		for (const result of report.cases) {
			if (result.outcome !== "unknown") continue;
			if (checks[result.check] === "pass") {
				throw new LiveEvidenceError(
					"EVIDENCE_UPGRADES_UNKNOWN",
					`case ${result.caseId} was not decided, so check ${result.check} cannot be a pass`,
				);
			}
		}
	}
}

/**
 * A compact JWS: a run of base64url characters that starts where a run starts
 * and holds an `ey` header of ten characters or more and a payload of ten or
 * more. The look-ahead reads the run once, so `-ey-ey-ey…` is one search; the
 * `\bey…` form this replaced started again at every `ey` and read to the end.
 * The same shape as `@hobo/provider-redaction`'s JWT_DETECTOR, kept here so the
 * conformance evidence gate does not depend on the redaction package.
 */
const JWT_SHAPE =
	/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.)(?:[A-Za-z0-9_]*-)*?ey[A-Za-z0-9_-]{10,}\./u;

/** A private key's BEGIN line, any label up to the next `-`. */
const PRIVATE_KEY_LINE = /-----BEGIN[^-]*PRIVATE KEY-----/u;

/** Values that must never appear anywhere in an artifact. */
export const SECRET_PATTERN: readonly RegExp[] = [
	// A connection string with credentials, looked for once per run of
	// characters that are neither whitespace nor a quote: at the run's first
	// `scheme://`, its first `:` after that and the first `@` after the `:`. A
	// later `scheme://` in the same run reaches a `:` and an `@` no earlier, so
	// it can match only where the first does; searching from every one of them,
	// and to the end of the run each time, was quadratic.
	...["postgres(?:ql)?", "rediss?", "mysql", "mongodb(?:\\+srv)?"].map(
		(scheme) =>
			new RegExp(
				`(?<![^\\s"])(?:(?!${scheme}:\\/\\/)[^\\s"])*${scheme}:\\/\\/[^\\s":]*:[^\\s"@]*@`,
				"i",
			),
	),
	PRIVATE_KEY_LINE,
	/\bBearer\s+[\u017F\u212AA-Za-z0-9._-]{8,}/i,
	/\b(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{16,}\b/u,
	JWT_SHAPE,
	/"(?:password|passwd|secret|apiKey|api_key|accessKey|access_key|token)"\s*:/i,
];

/**
 * Scan the serialized artifact for credential material.
 *
 * Deliberately a refusal rather than a redaction: if material reached this
 * point, the adapter has a leak that redacting one artifact would hide.
 */
export function assertSanitized(
	artifact: AnonymousTrustEvidenceArtifact,
): void {
	const serialized = JSON.stringify(artifact);
	for (const pattern of SECRET_PATTERN) {
		if (pattern.test(serialized)) {
			throw new LiveEvidenceError(
				"EVIDENCE_CONTAINS_SECRET",
				"the evidence artifact contains credential-shaped material and was not emitted",
			);
		}
	}
}

/** True only when every recorded check passed. `unknown` is not a pass. */
export function evidenceIsFullyPassing(
	artifact: AnonymousTrustEvidenceArtifact,
): boolean {
	const outcomes = Object.values(artifact.evidence.checks);
	return outcomes.length > 0 && outcomes.every((outcome) => outcome === "pass");
}

/**
 * The per-profile conformance verdict a Resource Definition records.
 *
 * `ProfileImplementation.conformance` is consumed directly by
 * `selectCapabilityImplementation`, and `unknown` there gates the candidate
 * out — which is the behavior we want for a partially-run suite.
 */
export function conformanceOutcomeFromArtifact(
	artifact: AnonymousTrustEvidenceArtifact,
): EvidenceCheckOutcome {
	return Object.values(artifact.evidence.checks).reduce<EvidenceCheckOutcome>(
		(accumulator, outcome) => worst(accumulator, outcome),
		"pass",
	);
}

/**
 * The two selection fields this artifact is allowed to fill in.
 *
 * `evidenceSignatureValid` comes from the injected verifier, never from the
 * artifact asserting its own signature is fine.
 */
export function selectionEvidenceFacts(
	artifact: AnonymousTrustEvidenceArtifact,
	verifier: EvidenceVerifier,
): SelectionEvidenceFacts {
	const outcome = verifier.verify({
		providerId: artifact.evidence.providerId,
		productDefinitionId: artifact.evidence.productDefinitionId,
		evidenceDigest: artifact.evidence.evidenceDigest,
		signature: artifact.evidence.signature,
	});
	return {
		evidenceExpiresAtMs: artifact.evidence.expiresAt,
		evidenceSignatureValid: outcome === "valid",
	};
}
