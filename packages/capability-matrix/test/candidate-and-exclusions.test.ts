/**
 * Candidate classification, ordering, and the claims that reach no cell.
 *
 * This package exists to stop one specific dishonesty: describing HoBo's own
 * budget or iron as market coverage. Every assertion below is written against
 * that — a bucket that absorbs a caveat, an ordering that lets registration
 * order change a published digest, or an exclusion that drops silently instead
 * of being reported all produce a matrix that *looks* like coverage and is not.
 */
import { describe, expect, it } from "vitest";

import {
	CANDIDATE_BUCKETS,
	CANDIDATE_UNAVAILABILITY_CODES,
	type CapabilityMatrixCandidate,
	cellKey,
	classifyCandidateBucket,
	compareCandidates,
	generateCapabilityMatrix,
	unavailabilityForEvidenceState,
} from "../src/index.js";
import {
	DAY,
	definition,
	matrixInput,
	NOW,
	PROFILE_REGISTRY,
	TRUST_EVIDENCE,
} from "./fixtures.js";

function candidate(
	overrides: Partial<CapabilityMatrixCandidate> = {},
): CapabilityMatrixCandidate {
	// SAFETY: callers may override only fields from the known candidate shape.
	return {
		primitive: "data",
		runtime: "oci",
		definitionId: "d",
		providerId: "p",
		profileId: "data.postgres/v1",
		realization: "native",
		bucket: "native",
		available: true,
		evidenceState: "fresh",
		conformance: "pass",
		conformanceRef: "suite",
		unavailability: [],
		...overrides,
	} as CapabilityMatrixCandidate;
}

function cellOf(
	matrix: ReturnType<typeof generateCapabilityMatrix>,
	key: string,
) {
	return matrix.cells.find((cell) => cell.key === key);
}

describe("classifyCandidateBucket", () => {
	it("returns the realization when neither caveat applies", () => {
		for (const realization of ["native", "pack", "bridge"] as const) {
			expect(
				classifyCandidateBucket({
					realization,
					sponsorExposureMinorUnits: 0,
					hoboOperatedSubstrate: false,
				}),
				realization,
			).toBe(realization);
		}
	});

	it("puts sponsorship above everything else", () => {
		// Money first. A sponsor-backed path works, but counting it as
		// provider-native would describe HoBo's budget as market coverage — which
		// is the single claim this package exists to prevent.
		expect(
			classifyCandidateBucket({
				realization: "native",
				sponsorExposureMinorUnits: 1,
				hoboOperatedSubstrate: true,
			}),
		).toBe("sponsor");
	});

	it("puts HoBo-operated substrate above the realization kind", () => {
		// The same argument one remove out: native-on-iron-HoBo-runs is not the
		// market implementing the primitive.
		expect(
			classifyCandidateBucket({
				realization: "native",
				sponsorExposureMinorUnits: 0,
				hoboOperatedSubstrate: true,
			}),
		).toBe("substrate");
	});

	it("treats zero and negative sponsor exposure as no sponsorship", () => {
		// `> 0`, not truthiness. A definition that records zero exposure is not
		// sponsored, and demoting it would understate real market coverage —
		// dishonest in the other direction.
		for (const sponsorExposureMinorUnits of [0, -1]) {
			expect(
				classifyCandidateBucket({
					realization: "native",
					sponsorExposureMinorUnits,
					hoboOperatedSubstrate: false,
				}),
				String(sponsorExposureMinorUnits),
			).toBe("native");
		}
	});

	it("demotes a pack or bridge to sponsor or substrate too", () => {
		// The caveats are not native-only. A sponsored pack is reported by its
		// strongest caveat, so no bucket ever hides a weaker one.
		expect(
			classifyCandidateBucket({
				realization: "pack",
				sponsorExposureMinorUnits: 500,
				hoboOperatedSubstrate: false,
			}),
		).toBe("sponsor");
		expect(
			classifyCandidateBucket({
				realization: "bridge",
				sponsorExposureMinorUnits: 0,
				hoboOperatedSubstrate: true,
			}),
		).toBe("substrate");
	});

	it("pins the closed bucket vocabulary", () => {
		expect(CANDIDATE_BUCKETS).toEqual([
			"native",
			"pack",
			"bridge",
			"substrate",
			"sponsor",
		]);
	});
});

describe("unavailabilityForEvidenceState", () => {
	it("maps every freshness state, and only fresh yields nothing", () => {
		expect(unavailabilityForEvidenceState("fresh")).toBeUndefined();
		expect(unavailabilityForEvidenceState("absent")).toBe("evidence-absent");
		expect(unavailabilityForEvidenceState("expired")).toBe("evidence-expired");
		expect(unavailabilityForEvidenceState("aged")).toBe("evidence-aged");
		// `aged` and `expired` are separate codes because they call for different
		// work: one is a renewal that has not happened yet, the other is a claim
		// that is already invalid.
		expect(unavailabilityForEvidenceState("future-dated")).toBe(
			"evidence-future-dated",
		);
	});

	it("pins the closed reason vocabulary", () => {
		// Every code is a fact about evidence or conformance, never about
		// preference — a candidate is never demoted for being slow or expensive.
		expect(CANDIDATE_UNAVAILABILITY_CODES).toEqual([
			"evidence-absent",
			"evidence-expired",
			"evidence-aged",
			"evidence-future-dated",
			"trust-gate-failed",
			"conformance-not-passing",
			"conformance-ref-missing",
		]);
	});
});

describe("compareCandidates", () => {
	it("orders by bucket rank before anything else", () => {
		const ranked = [
			candidate({ bucket: "sponsor", definitionId: "a" }),
			candidate({ bucket: "native", definitionId: "z" }),
			candidate({ bucket: "bridge", definitionId: "m" }),
			candidate({ bucket: "pack", definitionId: "b" }),
			candidate({ bucket: "substrate", definitionId: "c" }),
		].sort(compareCandidates);
		// Strongest coverage first, so a reader of a cell sees the honest answer
		// at the top rather than whichever definition sorted alphabetically.
		expect(ranked.map((c) => c.bucket)).toEqual([
			"native",
			"pack",
			"bridge",
			"substrate",
			"sponsor",
		]);
	});

	it("prefers an available candidate within a bucket", () => {
		const ranked = [
			candidate({ definitionId: "a", available: false }),
			candidate({ definitionId: "z", available: true }),
		].sort(compareCandidates);
		// Availability outranks the id: a usable candidate must surface above an
		// unusable one even when the unusable one sorts first alphabetically.
		expect(ranked.map((c) => c.definitionId)).toEqual(["z", "a"]);
	});

	it("falls back to definition id, then profile id", () => {
		const ranked = [
			candidate({ definitionId: "b", profileId: "p1" }),
			candidate({ definitionId: "a", profileId: "p2" }),
			candidate({ definitionId: "a", profileId: "p1" }),
		].sort(compareCandidates);
		expect(ranked.map((c) => `${c.definitionId}:${c.profileId}`)).toEqual([
			"a:p1",
			"a:p2",
			"b:p1",
		]);
	});

	it("is a total order — no key depends on registration order", () => {
		const same = candidate();
		// Zero for genuinely identical candidates, so the sort is stable and the
		// digest cannot shift between two runs over the same catalog.
		expect(compareCandidates(same, candidate())).toBe(0);
		expect(compareCandidates(same, same)).toBe(0);
	});

	it("is antisymmetric across every tie-break", () => {
		const pairs: Array<[CapabilityMatrixCandidate, CapabilityMatrixCandidate]> =
			[
				[candidate({ bucket: "native" }), candidate({ bucket: "sponsor" })],
				[candidate({ available: true }), candidate({ available: false })],
				[candidate({ definitionId: "a" }), candidate({ definitionId: "b" })],
				[candidate({ profileId: "a" }), candidate({ profileId: "b" })],
			];
		for (const [left, right] of pairs) {
			// A comparator that returned the same sign both ways would make
			// `Array.sort` implementation-defined, and the digest with it.
			expect(Math.sign(compareCandidates(left, right))).toBe(
				-Math.sign(compareCandidates(right, left)),
			);
		}
	});
});

describe("claims that reach no cell", () => {
	it("reports an unknown realization kind rather than guessing one", () => {
		const bad = definition({
			id: "bad.realization/v1",
			providerId: "bad",
			implementsProfiles: [
				{
					profileId: "data.postgres/v1",
					versionRange: ">=1",
					// SAFETY: this test deliberately injects an invalid realization.
					realization: "magic" as never,
					conformanceRef: "suite",
					conformance: "pass",
				},
			],
			runtimeModels: ["oci"],
		});
		const matrix = generateCapabilityMatrix(
			matrixInput({ definitions: [bad] }),
		);
		// Defaulting to `native` would be the worst possible guess: an unreadable
		// claim would be published as the strongest kind of coverage.
		const exclusion = matrix.excluded.find(
			(entry) => entry.definitionId === "bad.realization/v1",
		);
		expect(exclusion?.code).toBe("unknown-realization");
		expect(exclusion?.detail).toContain("magic");
		expect(cellOf(matrix, cellKey("data", "oci"))?.candidates).toEqual([]);
	});

	it("reports a definition that declares no runtime model", () => {
		const bad = definition({
			id: "no.runtime/v1",
			providerId: "bad",
			implementsProfiles: [
				{
					profileId: "data.postgres/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "suite",
					conformance: "pass",
				},
			],
			runtimeModels: [],
		});
		const matrix = generateCapabilityMatrix(
			matrixInput({ definitions: [bad] }),
		);
		// The grid is primitive x runtime. A claim naming no runtime reaches no
		// cell, and saying so is what stops it looking like coverage nobody can
		// find.
		expect(
			matrix.excluded.find((entry) => entry.definitionId === "no.runtime/v1")
				?.code,
		).toBe("no-runtime-model");
	});

	it("reports an unknown runtime model per claim, keeping the known ones", () => {
		const mixed = definition({
			id: "mixed.runtimes/v1",
			providerId: "mixed",
			implementsProfiles: [
				{
					profileId: "data.postgres/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "suite",
					conformance: "pass",
				},
			],
			// SAFETY: this test deliberately injects an invalid runtime model.
			runtimeModels: ["oci", "quantum" as never],
		});
		const matrix = generateCapabilityMatrix(
			matrixInput({
				definitions: [mixed],
				trustEvidence: TRUST_EVIDENCE,
			}),
		);
		// One bad runtime must not void the whole claim — the definition really
		// does cover `oci`, and dropping that would understate coverage.
		expect(
			matrix.excluded.find(
				(entry) => entry.definitionId === "mixed.runtimes/v1",
			)?.code,
		).toBe("unknown-runtime-model");
		expect(
			cellOf(matrix, cellKey("data", "oci"))?.candidates.map(
				(c) => c.definitionId,
			),
		).toContain("mixed.runtimes/v1");
	});

	it("keeps the definition and profile ids on every exclusion", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		for (const exclusion of matrix.excluded) {
			// An exclusion nobody can trace back to a catalog entry is an
			// unactionable report.
			expect(exclusion.definitionId.length).toBeGreaterThan(0);
			expect(exclusion.detail.length).toBeGreaterThan(0);
		}
		// The legacy entry is the one case with an empty profile id, because it
		// made no profile claim at all.
		const legacy = matrix.excluded.find(
			(entry) => entry.code === "no-declared-semantics",
		);
		expect(legacy?.profileId).toBe("");
	});
});

describe("candidate availability", () => {
	it("records every blocking reason, not just the first", () => {
		const doomed = definition({
			id: "doomed/v1",
			providerId: "doomed",
			implementsProfiles: [
				{
					profileId: "data.postgres/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "",
					conformance: "fail",
				},
			],
			runtimeModels: ["oci"],
		});
		const matrix = generateCapabilityMatrix(
			matrixInput({ definitions: [doomed], trustEvidence: new Map() }),
		);
		const found = cellOf(matrix, cellKey("data", "oci"))?.candidates[0];
		const codes = found?.unavailability.map((reason) => reason.code) ?? [];
		// Three independent problems, three reasons. Reporting only the first
		// would send an operator round the loop three times.
		expect(codes).toContain("evidence-absent");
		expect(codes).toContain("conformance-not-passing");
		expect(codes).toContain("conformance-ref-missing");
		expect(found?.available).toBe(false);
	});

	it("sorts reasons so a cell digests stably", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ trustEvidence: new Map() }),
		);
		for (const cell of matrix.cells) {
			for (const found of cell.candidates) {
				const codes = found.unavailability.map((reason) => reason.code);
				// Unsorted reasons would make the digest depend on the order the
				// checks happened to run in, which is exactly what a re-derivable
				// coverage claim cannot tolerate.
				expect([...codes].sort()).toEqual(codes);
			}
		}
	});

	it("makes `available` exactly the empty-reasons predicate", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		for (const cell of matrix.cells) {
			for (const found of cell.candidates) {
				// The type documents "empty exactly when available is true". If the
				// two could disagree, a cell could report coverage while naming the
				// reason it is not covered.
				expect(found.available, found.definitionId).toBe(
					found.unavailability.length === 0,
				);
			}
		}
	});

	it("carries the evidence expiry through when evidence exists", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		const covered = matrix.cells
			.flatMap((cell) => cell.candidates)
			.find((found) => found.available);
		// The expiry is what makes a regression predictable rather than a
		// surprise; a candidate with none cannot be warned about in advance.
		expect(covered?.evidenceExpiresAtMs).toBeGreaterThan(NOW);
	});

	it("reports absent evidence state and no expiry when nothing was recorded", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ trustEvidence: new Map() }),
		);
		const found = matrix.cells.flatMap((cell) => cell.candidates)[0];
		expect(found?.evidenceState).toBe("absent");
		// Absent, not zero: a zero expiry would read as "expired at the epoch",
		// which is a different and more alarming claim than "never recorded".
		expect(found?.evidenceExpiresAtMs).toBeUndefined();
	});

	it("regresses a covered cell once its evidence lapses, without deleting it", () => {
		const before = generateCapabilityMatrix(matrixInput());
		const after = generateCapabilityMatrix(
			matrixInput({ nowMs: NOW + 5 * DAY }),
		);
		const key = cellKey("kv", "serverless_faas");
		// The definition is still in the catalog and still in the cell — only its
		// availability changed. Removing it would hide that coverage was lost.
		expect(cellOf(before, key)?.buckets.native.available).toContain(
			"upstash.claimable-redis/v1",
		);
		expect(cellOf(after, key)?.buckets.native.unavailable).toContain(
			"upstash.claimable-redis/v1",
		);
		expect(
			cellOf(after, key)?.candidates.some(
				(c) => c.definitionId === "upstash.claimable-redis/v1",
			),
		).toBe(true);
	});
});

describe("bucket membership", () => {
	it("never lists one definition as both available and unavailable in a bucket", () => {
		// A definition may claim the same cell twice through two profiles. If
		// either claim is usable the definition is usable; listing it in both
		// columns would let a reader count the same product as coverage and as a
		// gap simultaneously.
		const twice = definition({
			id: "twice.claiming/v1",
			providerId: "twice",
			implementsProfiles: [
				{
					profileId: "data.postgres/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "suite",
					conformance: "pass",
				},
				{
					profileId: "data.postgres/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "",
					conformance: "pass",
				},
			],
			runtimeModels: ["oci"],
		});
		const evidenceRef = twice.semantics?.trustEvidenceRef ?? "";
		const fresh = [...TRUST_EVIDENCE.values()][0];
		const matrix = generateCapabilityMatrix(
			matrixInput({
				definitions: [twice],
				trustEvidence: new Map(
					fresh !== undefined ? [[evidenceRef, fresh]] : [],
				),
			}),
		);
		const bucket = cellOf(matrix, cellKey("data", "oci"))?.buckets.native;
		const both = (bucket?.available ?? []).filter((id) =>
			(bucket?.unavailable ?? []).includes(id),
		);
		expect(both).toEqual([]);
	});

	it("de-duplicates and sorts each bucket list", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		for (const cell of matrix.cells) {
			for (const bucketName of CANDIDATE_BUCKETS) {
				const bucket = cell.buckets[bucketName];
				for (const list of [bucket.available, bucket.unavailable]) {
					// Sorted and unique, so two matrices over the same catalog diff
					// cleanly and the digest is a function of content alone.
					expect([...list].sort(), `${cell.key}/${bucketName}`).toEqual(list);
					expect(new Set(list).size).toBe(list.length);
				}
			}
		}
	});

	it("gives every grid cell all five buckets, even when empty", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ definitions: [], trustEvidence: new Map() }),
		);
		// An absent cell and an empty cell would otherwise be
		// indistinguishable, and only one of them is honest.
		expect(matrix.cells.length).toBeGreaterThan(0);
		for (const cell of matrix.cells) {
			for (const bucketName of CANDIDATE_BUCKETS) {
				expect(cell.buckets[bucketName], `${cell.key}/${bucketName}`).toEqual({
					available: [],
					unavailable: [],
				});
			}
		}
	});
});

describe("determinism", () => {
	it("is byte-identical across two runs over the same input", () => {
		const a = generateCapabilityMatrix(matrixInput());
		const b = generateCapabilityMatrix(matrixInput());
		// The function is pure by contract — no clock, no filesystem, no
		// randomness — so a coverage claim can be re-derived years later and
		// come out the same.
		expect(a.digest).toBe(b.digest);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("is independent of the order definitions were registered in", () => {
		const forward = generateCapabilityMatrix(matrixInput());
		const reversed = generateCapabilityMatrix(
			matrixInput({ definitions: [...matrixInput().definitions].reverse() }),
		);
		// Catalog registration order is an accident of startup. If it reached the
		// digest, two identical deployments would publish different coverage
		// claims.
		expect(reversed.digest).toBe(forward.digest);
	});

	it("changes the digest when the evaluation instant changes", () => {
		const now = generateCapabilityMatrix(matrixInput());
		const later = generateCapabilityMatrix(
			matrixInput({ nowMs: NOW + 5 * DAY }),
		);
		// The instant is part of the claim: "covered" is only ever true *as of*
		// a moment, so a digest that ignored it would let a stale claim be
		// presented as current.
		expect(later.digest).not.toBe(now.digest);
		expect(later.evaluatedAtMs).toBe(NOW + 5 * DAY);
	});

	it("pins the profile registry and trust bundle digests into the matrix", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		// Both inputs are digested into the result, so a matrix cannot be
		// re-attributed to a different registry or a different trust judgement
		// after the fact.
		expect(matrix.profileRegistryDigest).toBe(PROFILE_REGISTRY.digest);
		expect(matrix.trustBundleDigest).toMatch(/^sha256:/u);
	});
});
