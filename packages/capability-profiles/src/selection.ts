/**
 * Hard-gate compatibility filtering plus deterministic lexicographic ranking.
 *
 * There is deliberately no weighted score here. A cheaper candidate never
 * compensates for failed credential isolation, stale conformance evidence, or
 * a missing semantic guarantee — those are gates, and gates precede order.
 */
import type { CapabilityRequirement } from "@hobo/manifest-capability";
import type {
	ClaimAtomicity,
	ContinuityGrade,
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	ProviderClass,
	SelectionCandidate,
} from "@hobo/manifest-request";

import type { CapabilityProfileRegistry } from "./registry.js";

/** Stable machine-readable reasons a candidate was gated out. */
export const REJECTION_CODES = [
	"PROFILE_INCOMPATIBLE",
	"PROFILE_PROHIBITED",
	"RUNTIME_UNSUPPORTED",
	"REALIZATION_DENIED",
	"BOOTSTRAP_POLICY_DENIED",
	"CLAIM_MODE_INSUFFICIENT",
	"STRONG_CLAIM_REQUIRED",
	"BINDING_UNAVAILABLE",
	"MIGRATION_REQUIRED_BUT_UNAVAILABLE",
	"CONFORMANCE_FAILED",
	"EVIDENCE_STALE",
	"PROVIDER_MATURITY_DENIED",
	"TOO_MANY_CLAIM_ACTIONS",
	"SOURCE_DISCLOSURE_DENIED",
	"SPONSOR_BUDGET_EXCEEDED",
	"SECRET_CUSTODY_UNAVAILABLE",
	"ARCHITECTURE_UNSUPPORTED",
	"WEBSOCKET_REQUIRED",
	"PERSISTENCE_REQUIRED",
	"FEATURE_UNSATISFIED",
	"GUARANTEE_UNSATISFIED",
	"NO_REGISTERED_DRIVER",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

// `ProviderClass`, `CreatorAuthorityAfterClaim`, `ContinuityGrade`,
// `ClaimAtomicity`, `ProfileImplementation` and `SelectionCandidate` were
// declared here. They are now `@hobo/manifest-request`'s, imported above and
// re-exported from `src/index.ts`: a second declaration of the candidate shape
// would let this module's gates and a caller's literal drift apart silently,
// which is the failure the decomposition exists to remove.

export type TrustPolicy = {
	readonly minimumProviderClass: ProviderClass;
	readonly creatorAuthorityAfterClaim:
		| "must-be-absent"
		| "must-be-rotatable"
		| "may-be-retained";
	readonly maximumClaimActions: number;
	readonly maximumEvidenceAgeMs: number;
	readonly requireExportProfile: boolean;
	readonly allowSponsor: boolean;
	readonly allowPack: boolean;
	readonly allowBridge: boolean;
	readonly sponsorBudgetMinorUnits: number;
};

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
	minimumProviderClass: "verified-emerging",
	creatorAuthorityAfterClaim: "must-be-rotatable",
	maximumClaimActions: 2,
	maximumEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000,
	requireExportProfile: false,
	allowSponsor: true,
	allowPack: true,
	allowBridge: true,
	sponsorBudgetMinorUnits: 0,
};

export type SelectionRejection = {
	readonly definitionId: string;
	readonly code: RejectionCode;
	readonly detail: string;
};

export type SelectionInput = {
	readonly requirement: CapabilityRequirement;
	readonly registry: CapabilityProfileRegistry;
	readonly candidates: readonly SelectionCandidate[];
	readonly policy: TrustPolicy;
	/** Canonical evaluation instant. Passed in — selection never reads a clock. */
	readonly nowMs: number;
	/** Binding profiles the consuming workload can actually consume. */
	readonly consumableBindingProfiles?: readonly string[];
};

export type SelectionResult = {
	readonly ranked: readonly SelectionCandidate[];
	readonly winner?: SelectionCandidate;
	readonly rejections: readonly SelectionRejection[];
};

const PROVIDER_CLASS_RANK = {
	established: 0,
	"verified-emerging": 1,
	experimental: 2,
} satisfies Readonly<Record<ProviderClass, number>>;

const AUTHORITY_RANK = {
	absent: 0,
	rotatable: 1,
	"reauthorization-required": 2,
	retained: 3,
	unknown: 4,
} satisfies Readonly<Record<CreatorAuthorityAfterClaim, number>>;

const ATOMICITY_RANK = {
	"single-resource": 0,
	"provider-bundled": 1,
	"best-effort-saga": 2,
} satisfies Readonly<Record<ClaimAtomicity, number>>;

const CONTINUITY_RANK = {
	preserved: 0,
	rebound: 1,
	migrated: 2,
	"not-applicable": 3,
	changed: 4,
	discarded: 5,
} satisfies Readonly<Record<ContinuityGrade, number>>;

const CREDENTIAL_RANK = {
	revoked: 0,
	rotated: 1,
	reauthorized: 2,
	"not-applicable": 3,
	retained: 4,
	unknown: 5,
} satisfies Readonly<
	Record<SelectionCandidate["continuity"]["credentials"], number>
>;

function majorOf(profileId: string): number {
	const match = /\/v(\d+)$/u.exec(profileId);
	return match ? Number(match[1]) : 0;
}

function rangeAdmits(range: string, major: number): boolean {
	const trimmed = range.trim();
	if (trimmed === "*") return true;
	const match = /^([><]=?|=|\^|~)?\s*v?(\d+)/u.exec(trimmed);
	if (!match) return false;
	const bound = Number(match[2]);
	switch (match[1]) {
		case ">":
			return major > bound;
		case ">=":
		case undefined:
		case "^":
		case "~":
			return major >= bound;
		case "<":
			return major < bound;
		case "<=":
			return major <= bound;
		case "=":
			return major === bound;
		default:
			return false;
	}
}

/** Does the candidate implement (possibly via refinement) the required profile? */
function implementationFor(
	candidate: SelectionCandidate,
	requiredProfileId: string,
	requiredRange: string,
	registry: CapabilityProfileRegistry,
): ProfileImplementation | undefined {
	for (const implementation of candidate.implementsProfiles) {
		if (!registry.satisfies(implementation.profileId, requiredProfileId))
			continue;
		if (!rangeAdmits(requiredRange, majorOf(implementation.profileId)))
			continue;
		if (!rangeAdmits(implementation.versionRange, majorOf(requiredProfileId))) {
			continue;
		}
		return implementation;
	}
	return undefined;
}

function featureSatisfied(
	actual: boolean | number | string | readonly string[] | undefined,
	operator: string,
	expected: boolean | number | string | readonly string[],
): boolean {
	if (actual === undefined) return false;
	switch (operator) {
		case "equals":
			return actual === expected;
		case "at-least":
			return Number.isFinite(actual) && Number.isFinite(expected)
				? actual >= expected
				: false;
		case "at-most":
			return Number.isFinite(actual) && Number.isFinite(expected)
				? actual <= expected
				: false;
		case "one-of":
			return Array.isArray(expected) && expected.includes(actual);
		case "includes-all": {
			if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
			const have = new Set(actual);
			return expected.every((item) => have.has(item));
		}
		default:
			return false;
	}
}

/**
 * Apply hard gates, then order survivors lexicographically.
 *
 * Ordering (each key only breaks ties in the previous one):
 * evidence freshness → creator authority after claim → claim atomicity →
 * human action count → endpoint continuity → data continuity → credential
 * quality → export portability → sponsor exposure → provider maturity →
 * definition id.
 */
export function selectCapabilityImplementation(
	input: SelectionInput,
): SelectionResult {
	const { requirement, registry, policy, nowMs } = input;
	const rejections: SelectionRejection[] = [];
	const survivors: SelectionCandidate[] = [];

	const reject = (
		candidate: SelectionCandidate,
		code: RejectionCode,
		detail: string,
	): void => {
		rejections.push({ definitionId: candidate.definitionId, code, detail });
	};

	// Sorting the input first makes gate evaluation order independent of
	// registration order, which the metamorphic tests assert.
	const ordered = [...input.candidates].sort((a, b) =>
		a.definitionId.localeCompare(b.definitionId),
	);

	for (const candidate of ordered) {
		if (!candidate.hasRegisteredDriver) {
			reject(
				candidate,
				"NO_REGISTERED_DRIVER",
				"no effectful driver is registered",
			);
			continue;
		}
		if (!candidate.secretCustodyAvailable) {
			reject(
				candidate,
				"SECRET_CUSTODY_UNAVAILABLE",
				"provider credentials cannot be deposited into secret custody",
			);
			continue;
		}

		let gated = false;

		for (const constraint of requirement.requiredProfiles) {
			const implementation = implementationFor(
				candidate,
				constraint.profileId,
				constraint.versionRange,
				registry,
			);
			if (implementation === undefined) {
				reject(
					candidate,
					"PROFILE_INCOMPATIBLE",
					`does not implement ${constraint.profileId} ${constraint.versionRange}`,
				);
				gated = true;
				break;
			}
			if (implementation.conformance !== "pass") {
				reject(
					candidate,
					"CONFORMANCE_FAILED",
					`conformance for ${implementation.profileId} is ${implementation.conformance}`,
				);
				gated = true;
				break;
			}
			if (
				implementation.realization === "pack" &&
				(!requirement.realization.pack || !policy.allowPack)
			) {
				reject(
					candidate,
					"REALIZATION_DENIED",
					"pack realization is not allowed",
				);
				gated = true;
				break;
			}
			if (
				implementation.realization === "bridge" &&
				(!requirement.realization.bridge || !policy.allowBridge)
			) {
				reject(
					candidate,
					"REALIZATION_DENIED",
					"bridge realization is not allowed",
				);
				gated = true;
				break;
			}
			if (
				implementation.realization === "native" &&
				!requirement.realization.native
			) {
				reject(
					candidate,
					"REALIZATION_DENIED",
					"native realization is not allowed",
				);
				gated = true;
				break;
			}
		}
		if (gated) continue;

		for (const prohibited of requirement.prohibitedProfiles) {
			if (
				candidate.implementsProfiles.some((implementation) =>
					registry.satisfies(implementation.profileId, prohibited.profileId),
				)
			) {
				reject(
					candidate,
					"PROFILE_PROHIBITED",
					`implements prohibited profile ${prohibited.profileId}`,
				);
				gated = true;
				break;
			}
		}
		if (gated) continue;

		if (
			requirement.runtime.required !== undefined &&
			!candidate.runtimeModels.includes(requirement.runtime.required)
		) {
			reject(
				candidate,
				"RUNTIME_UNSUPPORTED",
				`does not support required runtime ${requirement.runtime.required}`,
			);
			continue;
		}
		if (
			requirement.runtime.allowed.length > 0 &&
			!candidate.runtimeModels.some((model) =>
				requirement.runtime.allowed.includes(model),
			)
		) {
			reject(
				candidate,
				"RUNTIME_UNSUPPORTED",
				`supports none of the allowed runtimes ${requirement.runtime.allowed.join(", ")}`,
			);
			continue;
		}

		for (const feature of requirement.features) {
			if (feature.necessity !== "required") continue;
			if (
				!featureSatisfied(
					candidate.structuredCapabilities[feature.key],
					feature.operator,
					feature.value,
				)
			) {
				reject(
					candidate,
					"FEATURE_UNSATISFIED",
					`feature ${feature.key} ${feature.operator} ${String(feature.value)} not satisfied`,
				);
				gated = true;
				break;
			}
		}
		if (gated) continue;

		for (const guarantee of requirement.guarantees) {
			if (
				!featureSatisfied(
					candidate.structuredCapabilities[guarantee.key],
					guarantee.operator,
					guarantee.value,
				)
			) {
				reject(
					candidate,
					"GUARANTEE_UNSATISFIED",
					`guarantee ${guarantee.key} not satisfied`,
				);
				gated = true;
				break;
			}
		}
		if (gated) continue;

		if (input.consumableBindingProfiles !== undefined) {
			const consumable = new Set(input.consumableBindingProfiles);
			if (
				!candidate.producesBindingProfiles.some((profile) =>
					consumable.has(profile),
				)
			) {
				reject(
					candidate,
					"BINDING_UNAVAILABLE",
					`produces ${candidate.producesBindingProfiles.join(", ") || "no bindings"}, none consumable by the workload`,
				);
				continue;
			}
		}

		for (const migration of requirement.portability.requiredMigrationProfiles) {
			if (!candidate.migrationProfiles.includes(migration)) {
				reject(
					candidate,
					"MIGRATION_REQUIRED_BUT_UNAVAILABLE",
					`missing migration profile ${migration}`,
				);
				gated = true;
				break;
			}
		}
		if (gated) continue;

		if (
			(requirement.portability.requireExportProfile ||
				policy.requireExportProfile) &&
			!candidate.supportsExport
		) {
			reject(candidate, "MIGRATION_REQUIRED_BUT_UNAVAILABLE", "no export path");
			continue;
		}

		if (
			PROVIDER_CLASS_RANK[candidate.providerClass] >
			PROVIDER_CLASS_RANK[policy.minimumProviderClass]
		) {
			reject(
				candidate,
				"PROVIDER_MATURITY_DENIED",
				`provider class ${candidate.providerClass} is below policy minimum ${policy.minimumProviderClass}`,
			);
			continue;
		}

		// Fail closed: absent, unsigned, or expired evidence is not selectable.
		if (!candidate.evidenceSignatureValid) {
			reject(
				candidate,
				"EVIDENCE_STALE",
				"trust evidence signature is not valid",
			);
			continue;
		}
		if (candidate.evidenceExpiresAtMs === undefined) {
			reject(candidate, "EVIDENCE_STALE", "no trust evidence recorded");
			continue;
		}
		if (candidate.evidenceExpiresAtMs <= nowMs) {
			reject(
				candidate,
				"EVIDENCE_STALE",
				`trust evidence expired at ${new Date(candidate.evidenceExpiresAtMs).toISOString()}`,
			);
			continue;
		}

		if (
			policy.creatorAuthorityAfterClaim === "must-be-absent" &&
			candidate.creatorAuthorityAfterClaim !== "absent"
		) {
			reject(
				candidate,
				"STRONG_CLAIM_REQUIRED",
				`creator authority after claim is ${candidate.creatorAuthorityAfterClaim}, policy requires absent`,
			);
			continue;
		}
		if (
			policy.creatorAuthorityAfterClaim === "must-be-rotatable" &&
			!["absent", "rotatable", "reauthorization-required"].includes(
				candidate.creatorAuthorityAfterClaim,
			)
		) {
			reject(
				candidate,
				"STRONG_CLAIM_REQUIRED",
				`creator authority after claim is ${candidate.creatorAuthorityAfterClaim} and cannot be rotated`,
			);
			continue;
		}

		if (candidate.claimActionCount > policy.maximumClaimActions) {
			reject(
				candidate,
				"TOO_MANY_CLAIM_ACTIONS",
				`${candidate.claimActionCount} human claim actions exceeds policy maximum ${policy.maximumClaimActions}`,
			);
			continue;
		}

		if (candidate.sponsorExposureMinorUnits > 0) {
			if (!policy.allowSponsor) {
				reject(
					candidate,
					"BOOTSTRAP_POLICY_DENIED",
					"sponsor-backed bootstrap is denied",
				);
				continue;
			}
			if (
				candidate.sponsorExposureMinorUnits > policy.sponsorBudgetMinorUnits
			) {
				reject(
					candidate,
					"SPONSOR_BUDGET_EXCEEDED",
					`sponsor exposure ${candidate.sponsorExposureMinorUnits} exceeds budget ${policy.sponsorBudgetMinorUnits}`,
				);
				continue;
			}
		}

		survivors.push(candidate);
	}

	const ranked = [...survivors].sort((a, b) => compareCandidates(a, b, nowMs));
	const winner = ranked[0];
	const rejectionsByCandidate = [...rejections].sort(
		(a, b) =>
			a.definitionId.localeCompare(b.definitionId) ||
			a.code.localeCompare(b.code),
	);
	return winner === undefined
		? { ranked, rejections: rejectionsByCandidate }
		: { ranked, winner, rejections: rejectionsByCandidate };
}

function compareCandidates(
	a: SelectionCandidate,
	b: SelectionCandidate,
	nowMs: number,
): number {
	// Fresher evidence first, bucketed by day so trivial clock differences do
	// not reorder otherwise-equivalent candidates.
	const freshnessA = Math.floor(
		((a.evidenceExpiresAtMs ?? nowMs) - nowMs) / 86_400_000,
	);
	const freshnessB = Math.floor(
		((b.evidenceExpiresAtMs ?? nowMs) - nowMs) / 86_400_000,
	);
	if (freshnessA !== freshnessB) return freshnessB - freshnessA;

	const authority =
		AUTHORITY_RANK[a.creatorAuthorityAfterClaim] -
		AUTHORITY_RANK[b.creatorAuthorityAfterClaim];
	if (authority !== 0) return authority;

	const atomicity =
		ATOMICITY_RANK[a.claimAtomicity] - ATOMICITY_RANK[b.claimAtomicity];
	if (atomicity !== 0) return atomicity;

	if (a.claimActionCount !== b.claimActionCount) {
		return a.claimActionCount - b.claimActionCount;
	}

	const endpoint =
		CONTINUITY_RANK[a.continuity.endpoint] -
		CONTINUITY_RANK[b.continuity.endpoint];
	if (endpoint !== 0) return endpoint;

	const data =
		CONTINUITY_RANK[a.continuity.data] - CONTINUITY_RANK[b.continuity.data];
	if (data !== 0) return data;

	const credentials =
		CREDENTIAL_RANK[a.continuity.credentials] -
		CREDENTIAL_RANK[b.continuity.credentials];
	if (credentials !== 0) return credentials;

	const portability = Number(b.supportsExport) - Number(a.supportsExport);
	if (portability !== 0) return portability;

	if (a.sponsorExposureMinorUnits !== b.sponsorExposureMinorUnits) {
		return a.sponsorExposureMinorUnits - b.sponsorExposureMinorUnits;
	}

	const maturity =
		PROVIDER_CLASS_RANK[a.providerClass] - PROVIDER_CLASS_RANK[b.providerClass];
	if (maturity !== 0) return maturity;

	return a.definitionId.localeCompare(b.definitionId);
}
