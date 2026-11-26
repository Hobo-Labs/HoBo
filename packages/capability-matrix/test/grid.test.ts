import { BINDLE_PRIMITIVES, BINDLE_RUNTIMES } from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	CAPABILITY_MATRIX_CELL_COUNT,
	CAPABILITY_MATRIX_COORDINATES,
	cellKey,
	coordinateIndex,
	generateCapabilityMatrix,
} from "../src/index.js";
import {
	matrixInput,
	NOW,
	PROFILE_REGISTRY,
	TEST_REQUIREMENT,
	TEST_VERIFIER,
} from "./fixtures.js";

describe("the grid", () => {
	it("is the full cross product of primitives and runtimes", () => {
		expect(BINDLE_PRIMITIVES).toHaveLength(10);
		expect(BINDLE_RUNTIMES).toHaveLength(5);
		expect(CAPABILITY_MATRIX_CELL_COUNT).toBe(50);
		expect(CAPABILITY_MATRIX_COORDINATES).toHaveLength(50);
	});

	it("carries exactly one coordinate per primitive/runtime pair", () => {
		const keys = new Set(
			CAPABILITY_MATRIX_COORDINATES.map((coordinate) => coordinate.key),
		);
		expect(keys.size).toBe(50);
		for (const primitive of BINDLE_PRIMITIVES) {
			for (const runtime of BINDLE_RUNTIMES) {
				expect(keys.has(cellKey(primitive, runtime))).toBe(true);
			}
		}
	});

	it("orders coordinates primitive-major, runtime-minor", () => {
		expect(CAPABILITY_MATRIX_COORDINATES[0]?.key).toBe("web/wasm");
		expect(CAPABILITY_MATRIX_COORDINATES[4]?.key).toBe("web/serverless_faas");
		expect(CAPABILITY_MATRIX_COORDINATES[5]?.key).toBe("api/wasm");
		expect(CAPABILITY_MATRIX_COORDINATES[49]?.key).toBe(
			"webhook/serverless_faas",
		);
		expect(coordinateIndex("api/wasm")).toBe(5);
		expect(coordinateIndex("not/a-cell")).toBe(-1);
	});
});

describe("a generated matrix", () => {
	it("reports every cell in canonical order, covered or not", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		expect(matrix.cells).toHaveLength(50);
		expect(matrix.cells.map((cell) => cell.key)).toEqual(
			CAPABILITY_MATRIX_COORDINATES.map((coordinate) => coordinate.key),
		);
		for (const cell of matrix.cells) {
			expect(cell.key).toBe(cellKey(cell.primitive, cell.runtime));
		}
	});

	it("is honestly empty when nothing is registered", () => {
		const matrix = generateCapabilityMatrix({
			definitions: [],
			profileRegistry: PROFILE_REGISTRY,
			trustEvidence: new Map(),
			nowMs: NOW,
			requirement: TEST_REQUIREMENT,
			verifier: TEST_VERIFIER,
		});
		expect(matrix.cells).toHaveLength(50);
		expect(matrix.cells.every((cell) => cell.verdict === "uncovered")).toBe(
			true,
		);
		expect(matrix.cells.flatMap((cell) => cell.candidates)).toHaveLength(0);
		expect(matrix.excluded).toHaveLength(0);
	});
});
