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

// SAFETY: JSON.stringify/parse round-trips the generated matrix as JSON.
const VALID = JSON.parse(
	JSON.stringify(generateCapabilityMatrix(matrixInput())),
) as JsonObject;

/** A deep clone of the valid matrix, so each test mutates in isolation. */
function clone(): JsonObject {
	// SAFETY: VALID is a generated JSON matrix and clone preserves that shape.
	return JSON.parse(JSON.stringify(VALID)) as JsonObject;
}

function firstPopulatedCellIndex(matrix: JsonObject): number {
	// SAFETY: matrix is a generated matrix with a cells array.
	const cells = matrix.cells as Array<{ candidates: JsonValue[] }>;
	return cells.findIndex((cell) => cell.candidates.length > 0);
}

function expectRefusal(run: () => void, match: RegExp): Error {
	try {
		run();
	} catch (error) {
		// SAFETY: every refusal path throws an Error.
		expect((error as Error).message).toMatch(match);
		// SAFETY: the caught refusal is the Error just asserted above.
		return error as Error;
	}
	expect.unreachable(`expected a refusal matching ${match}`);
	throw new Error("unreachable");
}

describe("round trip", () => {
	it("parses a matrix this package derived, unchanged", () => {
		const parsed = parseCapabilityMatrix(clone());
		// The derivation and the parser must agree exactly, or a matrix could be
		// published and then rejected by the very system that produced it.
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(VALID));
	});

	it("tryParse returns the matrix on success and undefined on failure", () => {
		expect(tryParseCapabilityMatrix(clone())).toBeDefined();
		// Undefined, not a result object — the `try` form exists so a caller
		// reading many stored matrices can skip the bad ones rather than
		// aborting the batch on the first, and it deliberately discards the
		// reason. A caller that needs the reason calls the throwing form.
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
		// Stricter than I assumed, and correctly so: the digest is what pins a
		// matrix to the registry and trust bundle it was derived against, so
		// "some non-empty string" is not a good enough check. Uppercase hex is
		// refused too, because the digests are compared with `!==` elsewhere and
		// two spellings of one digest would read as a mismatch.
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
		// SAFETY: clone() returns the generated matrix shape under test.
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const index = firstPopulatedCellIndex(bad);
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.definitionId = "  ";
		// Whitespace is not an identifier. Accepting it would let a candidate
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
			// The instant is what makes a claim re-derivable. A fractional or
			// stringly-typed one would not compare equal on the way back.
			expectRefusal(
				() => parseCapabilityMatrix(bad),
				/must be an integer epoch-millisecond instant/u,
			);
		}
	});

	it("refuses a non-boolean availability flag", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		// SAFETY: clone() returns the generated matrix shape under test.
		const cells = bad.cells as Array<{
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.available = "true";
		// `"false"` is truthy. A stringly-typed availability flag read by a
		// planner would select a candidate that is not selectable.
		expectRefusal(() => parseCapabilityMatrix(bad), /must be a boolean/u);
	});

	it("refuses an unknown vocabulary member", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		// SAFETY: clone() returns the generated matrix shape under test.
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
		// SAFETY: clone() returns the generated matrix shape under test.
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
		// Sortedness is not cosmetic here: the digest is computed over these
		// lists, so an unsorted one is a matrix whose digest cannot be
		// reproduced from its own contents.
		expectRefusal(
			() => parseCapabilityMatrix(withBucketIds(["z.def/v1", "a.def/v1"])),
			/must be sorted and unique/u,
		);
	});

	it("refuses a duplicated definition id", () => {
		// `previous >= current` catches equality as well as inversion — a
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
		// SAFETY: clone() returns the generated matrix shape under test.
		const cells = bad.cells as Array<{
			buckets: Record<string, { available: string[]; unavailable: string[] }>;
		}>;
		for (const cell of cells) {
			for (const name of Object.keys(cell.buckets)) {
				const bucket = cell.buckets[name];
				if (bucket !== undefined && bucket.available.length > 0) {
					bucket.unavailable = [...bucket.available];
					// A reader could count the same product as coverage and as a gap
					// at once, and both totals would be wrong.
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
		// SAFETY: clone() returns the generated matrix shape under test.
		const cells = bad.cells as Array<{
			key: string;
			candidates: Array<JsonObject>;
		}>;
		const found = cells[index]?.candidates[0];
		if (found === undefined) return;
		found.primitive = found.primitive === "data" ? "kv" : "data";
		// The comment in the source says it plainly: a candidate filed under the
		// wrong cell makes every per-cell count a lie while the grid still looks
		// complete.
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/is filed under .* but claims/u,
		);
	});

	it("refuses a primitive or runtime outside the Bindle vocabulary", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		// SAFETY: clone() returns the generated matrix shape under test.
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
		// SAFETY: clone() returns the generated matrix shape under test.
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
		// asserted with no evidence trail at all — the exact failure the whole
		// package exists to make impossible.
		//
		// Two independent guards catch it and the verdict check happens to fire
		// first: the cell still says `uncovered` while its buckets now imply
		// `sponsor-only`. Either refusal is correct, so this asserts the
		// disjunction rather than pinning which one wins — ordering between two
		// equally-valid guards is not a contract worth freezing.
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/no candidate in the cell accounts for|does not follow from the buckets/u,
		);
	});

	it("refuses a verdict that does not follow from the buckets", () => {
		const bad = clone();
		// SAFETY: clone() returns the generated matrix shape under test.
		const cells = bad.cells as Array<{
			verdict: string;
			candidates: JsonValue[];
		}>;
		const covered = cells.find((cell) => cell.verdict !== "uncovered");
		if (covered === undefined) return;
		covered.verdict = "uncovered";
		// The verdict is derived, not authored. A stored matrix whose verdict
		// disagreed with its own buckets would let a hand edit downgrade or
		// upgrade a cell without touching the evidence behind it.
		expectRefusal(
			() => parseCapabilityMatrix(bad),
			/does not follow from the buckets/u,
		);
	});

	it("accepts an empty bucket on an empty cell", () => {
		// The converse: a cell with no candidates and no bucket ids is the
		// honest representation of "nothing covers this", and must parse.
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
		// The path is what tells an operator which field of a large document to
		// fix; a bare "invalid matrix" would be unactionable on a 50-cell grid.
		// SAFETY: expectRefusal returns the parser's structured error.
		expect((error as { code?: string }).code).toBe("INVALID_CAPABILITY_MATRIX");
		// SAFETY: expectRefusal returns the parser's structured error.
		expect((error as { path?: string }).path).toContain("evaluatedAtMs");
	});

	it("uses a distinct code for an unknown vocabulary member", () => {
		const bad = clone();
		const index = firstPopulatedCellIndex(bad);
		// SAFETY: clone() returns the generated matrix shape under test.
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
		// A vocabulary the reader does not know may simply mean the reader is
		// older than the matrix — a different situation from a malformed
		// document, and one a caller may want to handle by upgrading.
		// SAFETY: expectRefusal returns the parser's structured error.
		expect((error as { code?: string }).code).toBe("UNKNOWN_VOCABULARY");
	});
});
