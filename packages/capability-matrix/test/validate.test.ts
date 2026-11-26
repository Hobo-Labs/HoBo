import { describe, expect, it } from "vitest";

import {
	blockingFindings,
	type CapabilityMatrixFinding,
	generateCapabilityMatrix,
	validateCapabilityMatrix,
} from "../src/index.js";
import { DAY, matrixInput, NOW } from "./fixtures.js";

function findingsFor(
	findings: readonly CapabilityMatrixFinding[],
	code: string,
): readonly CapabilityMatrixFinding[] {
	return findings.filter((finding) => finding.code === code);
}

describe("validation findings", () => {
	const validation = validateCapabilityMatrix(
		generateCapabilityMatrix(matrixInput()),
	);

	it("reports findings as data instead of throwing", () => {
		expect(Array.isArray(validation.findings)).toBe(true);
		expect(validation.matrixDigest).toMatch(/^sha256:/u);
		expect(validation.evaluatedAtMs).toBe(NOW);
	});

	it("counts every cell exactly once across the verdict summary", () => {
		expect(validation.summary).toHaveLength(7);
		const total = validation.summary.reduce(
			(sum, entry) => sum + entry.cells,
			0,
		);
		expect(total).toBe(50);
	});

	it("names every uncovered cell", () => {
		const uncovered = findingsFor(validation.findings, "uncovered-cell");
		expect(uncovered.length).toBe(
			validation.summary.find((entry) => entry.verdict === "uncovered")?.cells,
		);
		expect(
			uncovered.some(
				(finding) => finding.primitive === "web" && finding.runtime === "wasm",
			),
		).toBe(true);
		expect(uncovered[0]?.definitionIds).toEqual([]);
	});

	it("flags a cell covered only by a bridge", () => {
		const bridgeOnly = findingsFor(validation.findings, "bridge-only-cell");
		expect(bridgeOnly).toHaveLength(1);
		expect(bridgeOnly[0]?.primitive).toBe("data");
		expect(bridgeOnly[0]?.runtime).toBe("wasm");
		expect(bridgeOnly[0]?.definitionIds).toEqual([
			"hyperdrive.postgres-bridge/v1",
		]);
	});

	it("flags a cell covered only by a sponsor-backed fallback", () => {
		const sponsorOnly = findingsFor(validation.findings, "sponsor-only-cell");
		expect(sponsorOnly).toHaveLength(1);
		expect(sponsorOnly[0]?.runtime).toBe("serverless_faas");
		expect(sponsorOnly[0]?.severity).toBe("warning");
	});

	it("flags a cell whose only candidate has evidence about to expire", () => {
		const expiring = findingsFor(validation.findings, "expiring-evidence-cell");
		expect(expiring).toHaveLength(1);
		expect(expiring[0]?.primitive).toBe("kv");
		expect(expiring[0]?.definitionIds).toEqual(["upstash.claimable-redis/v1"]);
	});

	it("respects an explicit expiry horizon", () => {
		const narrow = validateCapabilityMatrix(
			generateCapabilityMatrix(matrixInput()),
			{ expiryHorizonMs: DAY },
		);
		expect(findingsFor(narrow.findings, "expiring-evidence-cell")).toHaveLength(
			0,
		);
		expect(narrow.expiryHorizonMs).toBe(DAY);
	});

	it("treats a claim without a conformance ref as blocking", () => {
		const unverifiable = findingsFor(
			validation.findings,
			"missing-conformance-ref",
		);
		expect(unverifiable).toHaveLength(1);
		expect(unverifiable[0]?.severity).toBe("error");
		expect(unverifiable[0]?.definitionIds).toEqual([
			"unproven.object-store/v1",
		]);
		expect(blockingFindings(validation).length).toBeGreaterThan(0);
	});

	it("reports a coverage regression as an error once evidence lapses", () => {
		const later = validateCapabilityMatrix(
			generateCapabilityMatrix(matrixInput({ nowMs: NOW + 3 * DAY })),
		);
		const lapsed = findingsFor(later.findings, "evidence-lapsed-cell");
		expect(
			lapsed.some(
				(finding) =>
					finding.primitive === "kv" && finding.runtime === "serverless_faas",
			),
		).toBe(true);
		expect(lapsed.every((finding) => finding.severity === "error")).toBe(true);
	});

	it("orders findings by cell so two reports diff cleanly", () => {
		const repeat = validateCapabilityMatrix(
			generateCapabilityMatrix(matrixInput()),
		);
		expect(repeat.findings).toEqual(validation.findings);
	});

	it("reports an empty catalog as fifty uncovered cells rather than an error", () => {
		const empty = validateCapabilityMatrix(
			generateCapabilityMatrix(matrixInput({ definitions: [] })),
		);
		expect(findingsFor(empty.findings, "uncovered-cell")).toHaveLength(50);
		expect(blockingFindings(empty)).toHaveLength(0);
	});
});
