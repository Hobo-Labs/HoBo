/**
 * `parseCapabilityMatrix` — the boundary a stored or transmitted matrix
 * crosses on the way back in.
 *
 * A capability matrix is a published claim about what HoBo can actually run
 * on. That makes the read side as load-bearing as the derivation: a matrix
 * that round-trips through storage, an API, or a hand edit and comes back
 * subtly wrong is a coverage claim nobody derived and nobody can reproduce.
 * Every refusal below names the specific lie it stops.
 */
import { describe, expect, it } from "vitest";

import {
	generateCapabilityMatrix,
	parseCapabilityMatrix,
	tryParseCapabilityMatrix,
} from "../src/index.js";
import { matrixInput } from "./fixtures.js";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| JsonValue[]
	| JsonObject;
type JsonObject = Record<string, JsonValue>;

const VALID = JSON.parse(
	JSON.stringify(generateCapabilityMatrix(matrixInput())),
) as JsonObject;

function clone(): JsonObject {
	return JSON.parse(JSON.stringify(VALID)) as JsonObject;
}

function firstPopulatedCellIndex(matrix: JsonObject): number {
	const cells = matrix.cells as Array<{ candidates: JsonValue[] }>;
	return cells.findIndex((cell) => cell.candidates.length > 0);
}

function expectRefusal(run: () => void, match: RegExp): Error {
	try {
		run();
	} catch (error) {
		expect((error as Error).message).toMatch(match);
		return error as Error;
	}
	expect.unreachable(`expected a refusal matching ${match}`);
	throw new Error("unreachable");
}

describe("round trip", () => {
	it("parses a matrix this package derived, unchanged", () => {
		const parsed = parseCapabilityMatrix(clone());
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(VALID));
	});

	it("tryParse returns the matrix on success and undefined on failure", () => {
		expect(tryParseCapabilityMatrix(clone())).toBeDefined();
		expect(tryParseCapabilityMatrix({ schemaVersion: "nope" })).toBeUndefined();
		expect(tryParseCapabilityMatrix(null)).toBeUndefined();
	});
});

describe("shape refusals", () => {
	it("refuses a non-object matrix", () => {
		for (const value of [null, [], "matrix", 7]) {
			expectRefusal(() => parseCapabilityMatrix(value), /must be an object/u);
		}
	});

	it("refuses a non-array cells list", () => {
		const bad = clone();
		bad.cells = {};
		expectRefusal(() => parseCapabilityMatrix(bad), /must be an array/u);
	});

	it("refuses a non-string where a string is required", () => {
		const bad = clone();
		bad.profileRegistryDigest = 7;
		expectRefusal(() => parseCapabilityMatrix(bad), /must be a string/u);
	});

	it("refuses a digest that is not a lowercase sha256 hex string", () => {
		for (const value of [
			"   ",
			"not-a-digest",
			`sha256:${"A".repeat(64)}`,
			`sha256:${"a".repeat(63)}`,
			"md5:0123",
		]) {
			const bad = clone();
			bad.profileRegistryDigest = value;
			expectRefusal(
				() => parseCapabilityMatrix(bad),
				/must be a lowercase sha256:<hex> digest/u,
			);
		}
	});

	it("refuses an empty string inside a list where an identifier is required", () => {
		const bad = clone();
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const index = firstPopulatedCellIndex(bad);
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.definitionId = "  ";
		// claim coverage under a name nothing can be traced back to.
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/must be a non-empty string/u,
		);
	});

	it("refuses a non-integer evaluation instant", () => {
		for (const value of [1.5, "1700000000000", Number.NaN]) {
			const bad = clone();
			bad.evaluatedAtMs = value;
			expectRefusal(
				() => parseCapabilityMatrix(bad),
				/must be an integer epoch-millisecond instant/u,
			);
		}
	});

	it("refuses a non-boolean availability flag", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.available = "true";
		expectRefusal(() => parseCapabilityMatrix(bad), /must be a boolean/u);
	});

	it("refuses an unknown vocabulary member", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.evidenceState = "probably-fine";
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/probably-fine|must be one of/u,
		);
	});
});

describe("ordering and uniqueness refusals", () => {
	function withBucketIds(ids: string[]): JsonObject {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		const cells = bad.cells as Array<{
			buckets: Record<string, { available: string[]; unavailable: string[] }>;
		}>;
		const cell = cells[index];
		if (cell !== undefined) {
			for (const name of Object.keys(cell.buckets)) {
				const bucket = cell.buckets[name];
				if (bucket !== undefined && bucket.available.length > 0) {
					bucket.available = ids;
					break;
				}
			}
		}
		return bad;
	}

	it("refuses an unsorted definition id list", () => {
		expectRefusal(
			() => parseCapabilityMatrix(withBucketIds(["z.def/v1", "a.def/v1"])),
			/must be sorted and unique/u,
		);
	});

	it("refuses a duplicated definition id", () => {
		// duplicate would let one product be counted twice as coverage.
		expectRefusal(
			() => parseCapabilityMatrix(withBucketIds(["a.def/v1", "a.def/v1"])),
			/must be sorted and unique/u,
		);
	});

	it("refuses an empty string inside a definition id list", () => {
		expectRefusal(
			() => parseCapabilityMatrix(withBucketIds(["", "a.def/v1"])),
			/must be a non-empty string/u,
		);
	});

	it("refuses a definition listed as both available and unavailable", () => {
		const bad = clone();
		const cells = bad.cells as Array<{
			buckets: Record<string, { available: string[]; unavailable: string[] }>;
		}>;
		for (const cell of cells) {
			for (const name of Object.keys(cell.buckets)) {
				const bucket = cell.buckets[name];
				if (bucket !== undefined && bucket.available.length > 0) {
					bucket.unavailable = [...bucket.available];
					// A reader could count the same product as coverage and as a gap
					expectRefusal(
						() => parseCapabilityMatrix(bad),
						/reported as both available and unavailable/u,
					);
					return;
				}
			}
		}
	});
});

describe("cross-field consistency refusals", () => {
	it("refuses a candidate filed under the wrong cell", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		const cells = bad.cells as Array<{
			key: string;
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.primitive = found.primitive === "data" ? "kv" : "data";
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/is filed under .* but claims/u,
		);
	});

	it("refuses a primitive or runtime outside the Bindle vocabulary", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.primitive = "telepathy";
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/is not a Bindle primitive and runtime pair/u,
		);
	});

	it("refuses bucket ids that no candidate in the cell accounts for", () => {
		const bad = clone();
		const cells = bad.cells as Array<{
			candidates: JsonValue[];
			buckets: Record<string, { available: string[]; unavailable: string[] }>;
		}>;
		const empty = cells.find((cell) => cell.candidates.length === 0);
		if (empty === undefined) return;
		const sponsor = empty.buckets.sponsor;
		if (sponsor === undefined) return;
		sponsor.available = ["phantom.product/v1"];
		// A bucket naming a product with no candidate behind it is coverage
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/no candidate in the cell accounts for|does not follow from the buckets/u,
		);
	});

	it("refuses a verdict that does not follow from the buckets", () => {
		const bad = clone();
		const cells = bad.cells as Array<{
			verdict: string;
			candidates: JsonValue[];
		}>;
		const covered = cells.find((cell) => cell.verdict !== "uncovered");
		if (covered === undefined) return;
		covered.verdict = "uncovered";
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/does not follow from the buckets/u,
		);
	});

	it("accepts an empty bucket on an empty cell", () => {
		const parsed = parseCapabilityMatrix(clone());
		expect(parsed.cells.some((cell) => cell.candidates.length === 0)).toBe(
			true,
		);
	});
});

describe("error shape", () => {
	it("carries a code and the failing path", () => {
		const bad = clone();
		bad.evaluatedAtMs = "nope";
		const error = expectRefusal(
			() => parseCapabilityMatrix(bad),
			/evaluatedAtMs/u,
		);
		expect((error as { code?: string }).code).toBe("INVALID_CAPABILITY_MATRIX");
		expect((error as { path?: string }).path).toContain("evaluatedAtMs");
	});

	it("uses a distinct code for an unknown vocabulary member", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.primitive = "telepathy";
		const error = expectRefusal(
			() => parseCapabilityMatrix(bad),
			/not a Bindle primitive/u,
		);
		expect((error as { code?: string }).code).toBe("UNKNOWN_VOCABULARY");
	});
});
