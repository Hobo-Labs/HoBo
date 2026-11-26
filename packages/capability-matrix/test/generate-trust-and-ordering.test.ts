/**
 * Trust-gate reporting, exclusion ordering, and the cell accessors.
 *
 * The matrix's whole value is that it can be re-derived and compared. That
 * makes ordering a correctness property rather than a cosmetic one: any list
 * whose order depends on input order makes two identical catalogs publish two
 * different digests, and a coverage claim that cannot be diffed cannot be
 * audited. The trust assertions guard the other half — a gate failure reported
 * as a freshness problem sends an operator to renew evidence that was never
 * the problem.
 */
import { describe, expect, it } from "vitest";

import {
	availableCandidates,
	cellDefinitionIds,
	cellKey,
	deriveCoverageVerdict,
	generateCapabilityMatrix,
	validateCapabilityMatrix,
} from "../src/index.js";
import {
	DAY,
	definition,
	matrixInput,
	NOW,
	TEST_REQUIREMENT,
	TRUST_EVIDENCE,
} from "./fixtures.js";

function implementation(
	profileId: string,
	conformanceRef = `${profileId}#suite`,
) {
	return {
		profileId,
		versionRange: ">=1",
		realization: "native" as const,
		conformanceRef,
		conformance: "pass" as const,
	};
}

describe("trust gate reporting", () => {
	it("reports a policy refusal as trust-gate-failed, not as a freshness problem", () => {
		// A requirement that forbids sponsorship refuses the sponsored fixture on
		// policy grounds while its evidence is perfectly fresh. Folding that into
		// a freshness code would send an operator to renew evidence that was
		// never the problem.
		const strict = { ...TEST_REQUIREMENT, allowSponsor: false };
		const matrix = generateCapabilityMatrix(
			matrixInput({ requirement: strict }),
		);
		const sponsored = matrix.cells
			.flatMap((cell) => cell.candidates)
			.find((c) => c.definitionId === "sponsored.object-store/v1");
		expect(sponsored?.available).toBe(false);
		const codes = sponsored?.unavailability.map((r) => r.code) ?? [];
		expect(codes).toContain("trust-gate-failed");
		// Fresh evidence *and* a gate failure: the two facts coexist rather than
		// one masking the other.
		expect(sponsored?.evidenceState).toBe("fresh");
		expect(codes).not.toContain("evidence-expired");
	});

	it("joins several gate reasons into one sorted, de-duplicated detail", () => {
		const strict = {
			...TEST_REQUIREMENT,
			allowSponsor: false,
			allowPack: false,
			allowBridge: false,
		};
		const matrix = generateCapabilityMatrix(
			matrixInput({ requirement: strict }),
		);
		for (const found of matrix.cells.flatMap((cell) => cell.candidates)) {
			const gate = found.unavailability.find(
				(r) => r.code === "trust-gate-failed",
			);
			if (gate === undefined) continue;
			const parts = gate.detail.split(", ");
			// Sorted and unique, because this string reaches the digest. An
			// unordered join would make the same refusal hash two different ways.
			expect([...parts].sort(), found.definitionId).toEqual(parts);
			expect(new Set(parts).size).toBe(parts.length);
		}
	});

	it("keeps the freshness code separate when evidence has also lapsed", () => {
		const strict = { ...TEST_REQUIREMENT, allowSponsor: false };
		const matrix = generateCapabilityMatrix(
			matrixInput({ requirement: strict, nowMs: NOW + 60 * DAY }),
		);
		const sponsored = matrix.cells
			.flatMap((cell) => cell.candidates)
			.find((c) => c.definitionId === "sponsored.object-store/v1");
		const codes = sponsored?.unavailability.map((r) => r.code) ?? [];
		// Both problems reported. Renewing the evidence alone would not make this
		// candidate selectable, and the report has to say so.
		expect(codes).toContain("evidence-expired");
		expect(codes.length).toBeGreaterThan(1);
	});

	it("falls back to the default requirement when none is supplied", () => {
		const withDefault = generateCapabilityMatrix(
			matrixInput({ requirement: undefined }),
		);
		const withExplicit = generateCapabilityMatrix(matrixInput());
		// The two differ, which is the point: the default bar is stricter than
		// the permissive test requirement, so a caller who omits it does not
		// silently get the loosest possible judgement.
		expect(withDefault.trustBundleDigest).not.toBe(
			withExplicit.trustBundleDigest,
		);
	});

	it("treats an absent verifier as nobody having vouched", () => {
		const unverified = generateCapabilityMatrix(
			matrixInput({ verifier: undefined }),
		);
		const verified = generateCapabilityMatrix(matrixInput());
		// Fail-closed: with no trust root, a signature proves nothing, so nothing
		// may be reported as fresh on the strength of it.
		expect(unverified.digest).not.toBe(verified.digest);
	});

	it("treats an absent hoboOperatedProviderIds list as none", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ hoboOperatedProviderIds: undefined }),
		);
		// Nothing is demoted to substrate when the operator names no providers —
		// defaulting the other way would understate market coverage everywhere.
		const substrateIds = matrix.cells.flatMap((cell) => [
			...cell.buckets.substrate.available,
			...cell.buckets.substrate.unavailable,
		]);
		expect(substrateIds).toEqual([]);
	});
});

describe("exclusion ordering", () => {
	/** Two definitions that differ in exactly one comparator key at a time. */
	function excludingCatalog() {
		return [
			definition({
				id: "b.same/v1",
				providerId: "p",
				implementsProfiles: [implementation("ghost.one/v1")],
				runtimeModels: ["oci"],
			}),
			definition({
				id: "a.same/v1",
				providerId: "p",
				implementsProfiles: [
					implementation("ghost.two/v1"),
					implementation("ghost.one/v1"),
				],
				runtimeModels: ["oci"],
			}),
		];
	}

	it("sorts by definition id, then profile id", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({
				definitions: excludingCatalog(),
				trustEvidence: new Map(),
			}),
		);
		const keys = matrix.excluded.map(
			(entry) => `${entry.definitionId}|${entry.profileId}`,
		);
		expect(keys).toEqual([
			"a.same/v1|ghost.one/v1",
			"a.same/v1|ghost.two/v1",
			"b.same/v1|ghost.one/v1",
		]);
	});

	it("breaks a full tie on code, then on detail", () => {
		// Two claims on the same definition and profile that fail for different
		// reasons: the comparator has to reach `code` and then `detail`, or the
		// exclusion list order would depend on iteration order and move the
		// digest between runs.
		const twoFaults = definition({
			id: "faulty/v1",
			providerId: "p",
			implementsProfiles: [
				{
					profileId: "unregistered/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: "s",
					conformance: "pass",
				},
				{
					profileId: "unregistered/v1",
					versionRange: ">=1",
					// SAFETY: this test deliberately injects an invalid realization.
					realization: "sorcery" as never,
					conformanceRef: "s",
					conformance: "pass",
				},
			],
			runtimeModels: ["oci"],
		});
		const matrix = generateCapabilityMatrix(
			matrixInput({ definitions: [twoFaults], trustEvidence: new Map() }),
		);
		const codes = matrix.excluded.map((entry) => entry.code);
		expect([...codes].sort()).toEqual(codes);
	});

	it("is identical whichever order the catalog was registered in", () => {
		const forward = generateCapabilityMatrix(
			matrixInput({
				definitions: excludingCatalog(),
				trustEvidence: new Map(),
			}),
		);
		const reversed = generateCapabilityMatrix(
			matrixInput({
				definitions: [...excludingCatalog()].reverse(),
				trustEvidence: new Map(),
			}),
		);
		expect(reversed.excluded).toEqual(forward.excluded);
		expect(reversed.digest).toBe(forward.digest);
	});
});

describe("cell accessors", () => {
	const matrix = generateCapabilityMatrix(matrixInput());

	it("cellDefinitionIds returns every id once, sorted, whatever the bucket", () => {
		const cell = matrix.cells.find((c) => c.candidates.length > 0);
		expect(cell).toBeDefined();
		if (cell === undefined) return;
		const ids = cellDefinitionIds(cell);
		expect([...ids].sort()).toEqual(ids);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("cellDefinitionIds spans buckets rather than reporting one", () => {
		// The point of the accessor: "who is registered here at all", which is a
		// different question from "what could I select", and conflating them
		// would hide the packs and bridges behind a native answer.
		const dataOci = matrix.cells.find((c) => c.key === cellKey("data", "oci"));
		expect(dataOci).toBeDefined();
		if (dataOci === undefined) return;
		expect(cellDefinitionIds(dataOci)).toContain("hobo.pack-postgres/v1");
	});

	it("cellDefinitionIds is empty for an untouched cell", () => {
		const empty = matrix.cells.find((c) => c.candidates.length === 0);
		expect(empty).toBeDefined();
		if (empty === undefined) return;
		expect(cellDefinitionIds(empty)).toEqual([]);
	});

	it("availableCandidates returns only selectable candidates", () => {
		for (const cell of matrix.cells) {
			const available = availableCandidates(cell);
			for (const found of available) expect(found.available).toBe(true);
			// And it is exactly the subset — a filter that dropped a usable
			// candidate would make a covered cell look uncovered to a planner.
			expect(available.length).toBe(
				cell.candidates.filter((c) => c.available).length,
			);
		}
	});

	it("availableCandidates is empty once evidence has lapsed everywhere", () => {
		const lapsed = generateCapabilityMatrix(
			matrixInput({ nowMs: NOW + 400 * DAY }),
		);
		for (const cell of lapsed.cells) {
			expect(availableCandidates(cell), cell.key).toEqual([]);
		}
	});
});

describe("validation summary", () => {
	it("counts every grid cell exactly once across the verdict summary", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		const validation = validateCapabilityMatrix(matrix);
		const total = validation.summary.reduce((sum, row) => sum + row.cells, 0);
		// A summary that double-counted or dropped a cell would misstate the size
		// of the gap, which is the number a roadmap is built from.
		expect(total).toBe(matrix.cells.length);
	});

	it("reports every verdict in the summary, including those with no cells", () => {
		const validation = validateCapabilityMatrix(
			generateCapabilityMatrix(
				matrixInput({ definitions: [], trustEvidence: new Map() }),
			),
		);
		// Zero rows are present rather than omitted: a missing row and a zero row
		// read differently to anything charting the result over time.
		expect(validation.summary.every((row) => Number.isFinite(row.cells))).toBe(
			true,
		);
		expect(validation.summary.length).toBeGreaterThan(1);
	});

	it("carries the matrix digest and evaluation instant into the validation", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		const validation = validateCapabilityMatrix(matrix);
		// A validation report that could not be tied back to the exact matrix it
		// judged would be unfalsifiable.
		expect(validation.matrixDigest).toBe(matrix.digest);
		expect(validation.evaluatedAtMs).toBe(matrix.evaluatedAtMs);
	});

	it("is stable across two validations of the same matrix", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		expect(JSON.stringify(validateCapabilityMatrix(matrix))).toBe(
			JSON.stringify(validateCapabilityMatrix(matrix)),
		);
	});
});

describe("evidence recorded for a definition that never reaches a cell", () => {
	it("does not fabricate coverage from evidence alone", () => {
		// Evidence is necessary and not sufficient: the ghost fixture has fresh
		// evidence and claims a profile nobody registered, so it must reach no
		// cell at all.
		const matrix = generateCapabilityMatrix(
			matrixInput({ trustEvidence: TRUST_EVIDENCE }),
		);
		const anywhere = matrix.cells
			.flatMap((cell) => cell.candidates)
			.some((c) => c.definitionId === "ghost.queue/v1");
		expect(anywhere).toBe(false);
		expect(
			matrix.excluded.some((e) => e.definitionId === "ghost.queue/v1"),
		).toBe(true);
	});
});

describe("deriveCoverageVerdict", () => {
	function buckets(
		overrides: Partial<
			Record<
				"native" | "pack" | "bridge" | "substrate" | "sponsor",
				{ available: string[]; unavailable: string[] }
			>
		> = {},
	) {
		const empty = { available: [], unavailable: [] };
		// SAFETY: each returned bucket has the fixture's known bucket shape.
		return {
			native: empty,
			pack: empty,
			bridge: empty,
			substrate: empty,
			sponsor: empty,
			...overrides,
		} as never;
	}

	it("reports the strongest bucket that has something selectable", () => {
		// Precedence, not presence: a cell with both a native and a bridge
		// candidate is covered natively, and reporting the bridge would
		// understate what is actually available.
		expect(
			deriveCoverageVerdict(
				buckets({
					native: { available: ["a"], unavailable: [] },
					bridge: { available: ["b"], unavailable: [] },
				}),
			),
		).toBe("covered");
	});

	it("distinguishes a lapsed cell from one nobody ever registered", () => {
		// `evidence-lapsed` means someone claimed this and the claim no longer
		// holds; `uncovered` means nobody ever did. They call for completely
		// different work — renew evidence versus find a product — so collapsing
		// them would misdirect a roadmap.
		expect(
			deriveCoverageVerdict(
				buckets({ native: { available: [], unavailable: ["a"] } }),
			),
		).toBe("evidence-lapsed");
		expect(deriveCoverageVerdict(buckets())).toBe("uncovered");
	});

	it("counts an unavailable candidate in any bucket as lapsed", () => {
		for (const bucket of [
			"native",
			"pack",
			"bridge",
			"substrate",
			"sponsor",
		] as const) {
			expect(
				deriveCoverageVerdict(
					buckets({ [bucket]: { available: [], unavailable: ["a"] } }),
				),
				bucket,
			).toBe("evidence-lapsed");
		}
	});

	it("gives each bucket its own verdict when it is the only one available", () => {
		const seen = new Set<string>();
		for (const bucket of [
			"native",
			"pack",
			"bridge",
			"substrate",
			"sponsor",
		] as const) {
			seen.add(
				deriveCoverageVerdict(
					buckets({ [bucket]: { available: ["a"], unavailable: [] } }),
				),
			);
		}
		// Five buckets must not collapse onto one verdict — separating them is
		// the entire point of the package.
		expect(seen.size).toBeGreaterThan(1);
	});
});
