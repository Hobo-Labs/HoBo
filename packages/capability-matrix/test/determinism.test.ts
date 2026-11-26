import { describe, expect, it } from "vitest";

import {
	generateCapabilityMatrix,
	renderCapabilityMatrixMarkdown,
} from "../src/index.js";
import { DAY, DEFINITIONS, matrixInput, NOW } from "./fixtures.js";

describe("determinism", () => {
	it("produces an identical digest for the same input twice", () => {
		const first = generateCapabilityMatrix(matrixInput());
		const second = generateCapabilityMatrix(matrixInput());
		expect(first.digest).toBe(second.digest);
		expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("produces identical markdown for the same input twice", () => {
		const first = renderCapabilityMatrixMarkdown(
			generateCapabilityMatrix(matrixInput()),
		);
		const second = renderCapabilityMatrixMarkdown(
			generateCapabilityMatrix(matrixInput()),
		);
		expect(first).toBe(second);
		expect(first.endsWith("\n")).toBe(true);
	});

	it("is independent of the order definitions were registered in", () => {
		const forwards = generateCapabilityMatrix(matrixInput());
		const backwards = generateCapabilityMatrix(
			matrixInput({ definitions: [...DEFINITIONS].reverse() }),
		);
		expect(backwards.digest).toBe(forwards.digest);
		expect(renderCapabilityMatrixMarkdown(backwards)).toBe(
			renderCapabilityMatrixMarkdown(forwards),
		);
	});

	it("changes the digest when coverage changes", () => {
		const today = generateCapabilityMatrix(matrixInput());
		const later = generateCapabilityMatrix(
			matrixInput({ nowMs: NOW + 3 * DAY }),
		);
		expect(later.digest).not.toBe(today.digest);
	});

	it("prints only the instant it was given, and no other clock", () => {
		const markdown = renderCapabilityMatrixMarkdown(
			generateCapabilityMatrix(matrixInput()),
		);
		expect(markdown).toContain(`\`${NOW}\``);
		expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
	});

	it("renders the buckets separately and labels what is held back", () => {
		const markdown = renderCapabilityMatrixMarkdown(
			generateCapabilityMatrix(matrixInput({ nowMs: NOW + 3 * DAY })),
		);
		expect(markdown).toContain("| primitive \\ runtime | wasm | oci |");
		expect(markdown).toContain("### data/paas");
		expect(markdown).toContain("- native: neon.claimable-postgres/v1");
		expect(markdown).toContain("- bridge: hyperdrive.postgres-bridge/v1");
		expect(markdown).toContain(
			"held back: upstash.claimable-redis/v1 (native)",
		);
	});

	it("says so plainly when nothing is registered", () => {
		const markdown = renderCapabilityMatrixMarkdown(
			generateCapabilityMatrix(matrixInput({ definitions: [] })),
		);
		expect(markdown).toContain("No definition is registered for any cell.");
		expect(markdown).toContain("uncovered");
	});
});
