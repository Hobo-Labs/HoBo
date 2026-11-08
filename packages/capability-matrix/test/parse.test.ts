import type { ResourceDefinitionVNext } from "@hobo/cloud";
import { describe, expect, it } from "vitest";

import {
	type CapabilityMatrixDocument,
	CapabilityMatrixError,
	generateCapabilityMatrix,
	parseCapabilityMatrix,
	tryParseCapabilityMatrix,
} from "../src/index.js";
import { matrixInput, NEON } from "./fixtures.js";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| JsonValue[]
	| JsonObject;
type JsonObject = Record<string, JsonValue>;

/** A matrix that has been through JSON, as a stored or transmitted one would. */
function documentOf(): JsonObject {
	// SAFETY: JSON.stringify/parse round-trips the generated matrix as JSON.
	return JSON.parse(
		JSON.stringify(generateCapabilityMatrix(matrixInput())),
	) as JsonObject;
}

function cells(document: JsonObject): JsonObject[] {
	// SAFETY: documentOf() returns a generated matrix with a cells array.
	return document.cells as JsonObject[];
}

function expectRejection(
	document: CapabilityMatrixDocument,
	code: string,
): void {
	expect(() => parseCapabilityMatrix(document)).toThrow(CapabilityMatrixError);
	try {
		parseCapabilityMatrix(document);
	} catch (error) {
		// SAFETY: parseCapabilityMatrix throws CapabilityMatrixError on refusal.
		expect((error as CapabilityMatrixError).code).toBe(code);
	}
}

describe("the read boundary", () => {
	it("round-trips a generated matrix through JSON", () => {
		const generated = generateCapabilityMatrix(matrixInput());
		const parsed = parseCapabilityMatrix(JSON.parse(JSON.stringify(generated)));
		expect(parsed).toEqual(generated);
		expect(parsed.digest).toBe(generated.digest);
	});

	it("refuses a grid that is missing a cell", () => {
		const document = documentOf();
		document.cells = cells(document).slice(0, 49);
		expectRejection(document, "INCOMPLETE_GRID");
	});

	it("refuses a grid whose cells are out of canonical order", () => {
		const document = documentOf();
		const ordered = cells(document);
		document.cells = [ordered[1], ordered[0], ...ordered.slice(2)];
		expectRejection(document, "INCOMPLETE_GRID");
	});

	it("refuses a verdict that does not follow from the buckets", () => {
		const document = documentOf();
		const uncovered = cells(document).find(
			(cell) => cell.verdict === "uncovered",
		);
		expect(uncovered).toBeDefined();
		if (uncovered !== undefined) uncovered.verdict = "covered";
		expectRejection(document, "INVALID_CAPABILITY_MATRIX");
	});

	it("refuses a verdict outside the closed vocabulary", () => {
		const document = documentOf();
		const first = cells(document)[0];
		if (first !== undefined) first.verdict = "mostly-fine";
		expectRejection(document, "UNKNOWN_VOCABULARY");
	});

	it("refuses a bucket whose ids are unsorted or duplicated", () => {
		const document = documentOf();
		// SAFETY: cells() returns generated matrix cell objects with buckets.
		const first = cells(document)[0] as JsonObject;
		// SAFETY: generated cells carry a buckets object.
		(first.buckets as JsonObject).native = {
			available: ["b/v1", "a/v1"],
			unavailable: [],
		};
		expectRejection(document, "INVALID_CAPABILITY_MATRIX");
	});

	it("refuses a digest that does not describe the body", () => {
		const document = documentOf();
		document.digest = `sha256:${"0".repeat(64)}`;
		expectRejection(document, "DIGEST_MISMATCH");
	});

	it("refuses a digest that is not a sha256 digest at all", () => {
		const document = documentOf();
		document.digest = "not-a-digest";
		expectRejection(document, "INVALID_CAPABILITY_MATRIX");
	});

	it("refuses an unsupported schema version and a non-object", () => {
		const document = documentOf();
		document.schemaVersion = "hobo.capability-matrix/v0";
		expectRejection(document, "INVALID_CAPABILITY_MATRIX");
		expectRejection(null, "INVALID_CAPABILITY_MATRIX");
		expectRejection([], "INVALID_CAPABILITY_MATRIX");
	});

	it("refuses a candidate that claims availability while recording a reason", () => {
		const document = documentOf();
		// SAFETY: documentOf() returns a matrix with at least one populated cell.
		const cell = cells(document).find(
			(entry) => Array.isArray(entry.candidates) && entry.candidates.length > 0,
		) as JsonObject;
		// SAFETY: the selected populated cell contains candidate objects.
		const candidate = (cell.candidates as JsonObject[])[0];
		if (candidate !== undefined) {
			candidate.unavailability = [
				{ code: "evidence-expired", detail: "tampered" },
			];
		}
		expectRejection(document, "INVALID_CAPABILITY_MATRIX");
	});

	it("returns undefined rather than throwing in the non-throwing variant", () => {
		expect(
			tryParseCapabilityMatrix({ schemaVersion: "wrong" }),
		).toBeUndefined();
		expect(tryParseCapabilityMatrix(documentOf())).toBeDefined();
	});
});

describe("catalog compatibility", () => {
	it("accepts a full ResourceDefinitionVNext from @hobo/cloud", () => {
		const semantics = NEON.semantics;
		expect(semantics).toBeDefined();
		if (semantics === undefined) return;
		const full: ResourceDefinitionVNext = {
			id: NEON.id,
			providerId: NEON.providerId,
			port: "data",
			features: ["postgres"],
			regions: ["us-east-1"],
			specificity: 1,
			priority: 1,
			cost: { sku: "neon-free", unit: "hour", marginalPrice: "0.00" },
			satisfies: () => ({ kind: "full" }),
			semantics,
		};
		const matrix = generateCapabilityMatrix(
			matrixInput({ definitions: [full] }),
		);
		const cell = matrix.cells.find((entry) => entry.key === "data/paas");
		expect(cell?.buckets.native.available).toEqual([NEON.id]);
		expect(cell?.verdict).toBe("covered");
	});
});
