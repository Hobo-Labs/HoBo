/**
 * Derivation of the capability matrix from registry facts.
 *
 * There is no coverage table in this package. `generateCapabilityMatrix` walks
 * the definitions it is handed, asks `@hobo/capability-profiles` which
 * primitive each claimed profile belongs to, asks `@hobo/trust` whether the
 * evidence behind each definition holds at the supplied instant, and fills the
 * grid with whatever survives. Hand nothing in and the matrix is honestly
 * empty; let evidence expire and cells regress on their own.
 *
 * The function is pure: no clock, no filesystem, no network, no randomness.
 * `nowMs` is an argument so a coverage claim can be re-derived years later and
 * come out byte-identical.
 */
import {
	type BindleRuntime,
	type CapabilityProfileRegistry,
	isBindleRuntime,
	REALIZATION_KINDS,
	type RealizationKind,
} from "@hobo/capability-profiles";
import type { ResourceDefinitionVNext } from "@hobo/cloud";
import {
	DEFAULT_TRUST_REQUIREMENT,
	type EvidenceVerifier,
	evaluateTrustBundle,
	type TrustBundleSubject,
	type TrustBundleSubjectVerdict,
	type TrustEvidence,
	type TrustRequirement,
} from "@hobo/trust";

import {
	type CandidateUnavailability,
	type CapabilityMatrixCandidate,
	classifyCandidateBucket,
	compareCandidates,
	unavailabilityForEvidenceState,
} from "./candidate.js";
import { capabilityMatrixDigest } from "./digest.js";
import {
	CAPABILITY_MATRIX_COORDINATES,
	type CapabilityMatrixCellKey,
	cellKey,
} from "./grid.js";
import {
	CAPABILITY_MATRIX_SCHEMA_VERSION,
	type CapabilityMatrix,
	type CapabilityMatrixBucket,
	type CapabilityMatrixBuckets,
	type CapabilityMatrixCell,
	type CapabilityMatrixExclusion,
	deriveCoverageVerdict,
	type MatrixExclusionCode,
} from "./matrix.js";

export type RegisteredDefinition = Pick<
	ResourceDefinitionVNext,
	"id" | "providerId" | "semantics"
>;

export type CapabilityMatrixInput = {
	readonly definitions: readonly RegisteredDefinition[];
	readonly profileRegistry: CapabilityProfileRegistry;
	readonly trustEvidence: ReadonlyMap<string, TrustEvidence>;
	readonly nowMs: number;
	readonly requirement?: TrustRequirement | undefined;
	readonly verifier?: EvidenceVerifier | undefined;
	readonly hoboOperatedProviderIds?: readonly string[] | undefined;
};

const FRESHNESS_REASON_CODES: ReadonlySet<string> = new Set([
	"EVIDENCE_ABSENT",
	"EVIDENCE_STALE",
]);

function sortedUnique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function compareExclusions(
	a: CapabilityMatrixExclusion,
	b: CapabilityMatrixExclusion,
): number {
	if (a.definitionId !== b.definitionId) {
		return a.definitionId < b.definitionId ? -1 : 1;
	}
	if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
	if (a.code !== b.code) return a.code < b.code ? -1 : 1;
	return a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}

function isRealizationKind(value: string): value is RealizationKind {
	// SAFETY: REALIZATION_KINDS is the closed runtime vocabulary for this field.
	return (REALIZATION_KINDS as readonly string[]).includes(value);
}

function unavailabilityOf(
	subject: TrustBundleSubjectVerdict | undefined,
	conformance: "pass" | "fail" | "unknown",
	conformanceRef: string | undefined,
): readonly CandidateUnavailability[] {
	const reasons: CandidateUnavailability[] = [];

	if (subject === undefined) {
		reasons.push({
			code: "evidence-absent",
			detail: "no trust evidence was recorded for this definition",
		});
	} else {
		const evidenceCode = unavailabilityForEvidenceState(
			subject.freshness.state,
		);
		if (evidenceCode !== undefined) {
			reasons.push({ code: evidenceCode, detail: subject.freshness.detail });
		}
		const otherReasons = subject.verdict.reasons.filter(
			(reason) => !FRESHNESS_REASON_CODES.has(reason.code),
		);
		if (otherReasons.length > 0) {
			reasons.push({
				code: "trust-gate-failed",
				detail: sortedUnique(otherReasons.map((reason) => reason.code)).join(
					", ",
				),
			});
		}
	}

	if (conformance !== "pass") {
		reasons.push({
			code: "conformance-not-passing",
			detail: `conformance outcome is ${conformance}`,
		});
	}
	if (conformanceRef === undefined) {
		reasons.push({
			code: "conformance-ref-missing",
			detail: "the implementation claim names no conformance suite",
		});
	}

	return reasons.sort(
		(a, b) =>
			(a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
			(a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0),
	);
}

function bucketOf(
	candidates: readonly CapabilityMatrixCandidate[],
	bucket: CapabilityMatrixCandidate["bucket"],
): CapabilityMatrixBucket {
	const mine = candidates.filter((candidate) => candidate.bucket === bucket);
	const available = sortedUnique(
		mine
			.filter((candidate) => candidate.available)
			.map((candidate) => candidate.definitionId),
	);
	const availableSet = new Set(available);
	const unavailable = sortedUnique(
		mine
			.filter(
				(candidate) =>
					!candidate.available && !availableSet.has(candidate.definitionId),
			)
			.map((candidate) => candidate.definitionId),
	);
	return { available, unavailable };
}

function bucketsOf(
	candidates: readonly CapabilityMatrixCandidate[],
): CapabilityMatrixBuckets {
	return {
		native: bucketOf(candidates, "native"),
		pack: bucketOf(candidates, "pack"),
		bridge: bucketOf(candidates, "bridge"),
		substrate: bucketOf(candidates, "substrate"),
		sponsor: bucketOf(candidates, "sponsor"),
	};
}

export function generateCapabilityMatrix(
	input: CapabilityMatrixInput,
): CapabilityMatrix {
	const requirement = input.requirement ?? DEFAULT_TRUST_REQUIREMENT;
	const hoboOperated = new Set(input.hoboOperatedProviderIds ?? []);
	const excluded: CapabilityMatrixExclusion[] = [];
	const byCell = new Map<
		CapabilityMatrixCellKey,
		CapabilityMatrixCandidate[]
	>();
	for (const coordinate of CAPABILITY_MATRIX_COORDINATES) {
		byCell.set(coordinate.key, []);
	}

	const definitions = [...input.definitions].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);

	const subjectInputs: TrustBundleSubject[] = [];
	for (const definition of definitions) {
		const semantics = definition.semantics;
		if (semantics === undefined) continue;
		const evidence = input.trustEvidence.get(semantics.trustEvidenceRef);
		subjectInputs.push(
			evidence === undefined
				? { subjectId: definition.id }
				: { subjectId: definition.id, evidence },
		);
	}
	const bundleInput = {
		subjects: subjectInputs,
		requirement,
		nowMs: input.nowMs,
		verifier: input.verifier,
	};
	const bundle =
		input.verifier === undefined
			? evaluateTrustBundle({
					subjects: bundleInput.subjects,
					requirement: bundleInput.requirement,
					nowMs: bundleInput.nowMs,
				})
			: evaluateTrustBundle({
					subjects: bundleInput.subjects,
					requirement: bundleInput.requirement,
					nowMs: bundleInput.nowMs,
					verifier: input.verifier,
				});
	const subjects = new Map<string, TrustBundleSubjectVerdict>(
		bundle.subjects.map((subject) => [subject.subjectId, subject]),
	);

	const exclude = (
		definitionId: string,
		profileId: string,
		code: MatrixExclusionCode,
		detail: string,
	): void => {
		excluded.push({ definitionId, profileId, code, detail });
	};

	for (const definition of definitions) {
		const semantics = definition.semantics;
		if (semantics === undefined) {
			exclude(
				definition.id,
				"",
				"no-declared-semantics",
				"definition declares no semantics block and is never promoted into profile matching",
			);
			continue;
		}

		const subject = subjects.get(definition.id);
		const evidence = input.trustEvidence.get(semantics.trustEvidenceRef);

		for (const implementation of semantics.implementsProfiles) {
			const profile = input.profileRegistry.get(implementation.profileId);
			if (profile === undefined) {
				exclude(
					definition.id,
					implementation.profileId,
					"unregistered-profile",
					`profile ${implementation.profileId} is not in the capability profile registry`,
				);
				continue;
			}
			if (!isRealizationKind(implementation.realization)) {
				exclude(
					definition.id,
					implementation.profileId,
					"unknown-realization",
					`realization ${JSON.stringify(implementation.realization)} is not a known realization kind`,
				);
				continue;
			}
			if (semantics.runtimeModels.length === 0) {
				exclude(
					definition.id,
					implementation.profileId,
					"no-runtime-model",
					"definition declares no runtime model, so the claim reaches no cell",
				);
				continue;
			}

			const conformanceRef =
				implementation.conformanceRef.trim().length > 0
					? implementation.conformanceRef
					: undefined;
			const unavailability = unavailabilityOf(
				subject,
				implementation.conformance,
				conformanceRef,
			);
			const bucket = classifyCandidateBucket({
				realization: implementation.realization,
				sponsorExposureMinorUnits: semantics.sponsorExposureMinorUnits,
				hoboOperatedSubstrate: hoboOperated.has(definition.providerId),
			});

			for (const runtimeModel of semantics.runtimeModels) {
				if (!isBindleRuntime(runtimeModel)) {
					exclude(
						definition.id,
						implementation.profileId,
						"unknown-runtime-model",
						`runtime model ${JSON.stringify(runtimeModel)} is not a known Bindle runtime`,
					);
					continue;
				}
				const runtime: BindleRuntime = runtimeModel;
				const candidate: Omit<
					CapabilityMatrixCandidate,
					"evidenceExpiresAtMs" | "conformanceRef"
				> & {
					evidenceExpiresAtMs?: number;
					conformanceRef?: string;
				} = {
					primitive: profile.primitive,
					runtime,
					definitionId: definition.id,
					providerId: definition.providerId,
					profileId: implementation.profileId,
					realization: implementation.realization,
					bucket,
					available: unavailability.length === 0,
					evidenceState: subject?.freshness.state ?? "absent",
					conformance: implementation.conformance,
					unavailability,
				};
				if (evidence !== undefined)
					candidate.evidenceExpiresAtMs = evidence.expiresAt;
				if (conformanceRef !== undefined)
					candidate.conformanceRef = conformanceRef;
				byCell.get(cellKey(profile.primitive, runtime))?.push(candidate);
			}
		}
	}

	const cells: CapabilityMatrixCell[] = CAPABILITY_MATRIX_COORDINATES.map(
		(coordinate) => {
			const candidates = [...(byCell.get(coordinate.key) ?? [])].sort(
				compareCandidates,
			);
			const buckets = bucketsOf(candidates);
			return {
				key: coordinate.key,
				primitive: coordinate.primitive,
				runtime: coordinate.runtime,
				verdict: deriveCoverageVerdict(buckets),
				buckets,
				candidates,
			};
		},
	);

	const body = {
		schemaVersion: CAPABILITY_MATRIX_SCHEMA_VERSION,
		evaluatedAtMs: input.nowMs,
		profileRegistryDigest: input.profileRegistry.digest,
		trustBundleDigest: bundle.bundleDigest,
		cells,
		excluded: excluded.sort(compareExclusions),
	} as const;

	return { ...body, digest: capabilityMatrixDigest(body) };
}
