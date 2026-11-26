import { describe, expect, it } from "vitest";

import {
	type CapabilityMatrix,
	type CapabilityMatrixCell,
	generateCapabilityMatrix,
} from "../src/index.js";
import { DAY, EXPIRING, matrixInput, NOW } from "./fixtures.js";

function cellOf(matrix: CapabilityMatrix, key: string): CapabilityMatrixCell {
	const cell = matrix.cells.find((entry) => entry.key === key);
	if (cell === undefined) throw new Error(`no cell ${key}`);
	return cell;
}

describe("bucket separation", () => {
	const matrix = generateCapabilityMatrix(matrixInput());

	it("keeps a provider-native product out of the pack and bridge buckets", () => {
		const cell = cellOf(matrix, "data/paas");
		expect(cell.buckets.native.available).toEqual([
			"neon.claimable-postgres/v1",
		]);
		expect(cell.buckets.pack.available).toEqual([]);
		expect(cell.buckets.bridge.available).toEqual([]);
		expect(cell.buckets.substrate.available).toEqual([]);
		expect(cell.buckets.sponsor.available).toEqual([]);
		expect(cell.verdict).toBe("covered");
	});

	it("reports a HoBo pack on generic compute as a pack, not as coverage by a provider", () => {
		const cell = cellOf(matrix, "data/oci");
		expect(cell.buckets.pack.available).toEqual(["hobo.pack-postgres/v1"]);
		expect(cell.buckets.native.available).toEqual([]);
		expect(cell.verdict).toBe("pack-only");
	});

	it("reports a bridge as a bridge and never as covered", () => {
		const cell = cellOf(matrix, "data/wasm");
		expect(cell.buckets.bridge.available).toEqual([
			"hyperdrive.postgres-bridge/v1",
		]);
		expect(cell.buckets.native.available).toEqual([]);
		expect(cell.verdict).toBe("bridge-only");
	});

	it("moves a natively-realized product to the substrate bucket when HoBo runs the iron", () => {
		const cell = cellOf(matrix, "kv/vm_iaas");
		expect(cell.buckets.substrate.available).toEqual([
			"hobo.operated-redis/v1",
		]);
		expect(cell.buckets.native.available).toEqual([]);
		expect(cell.verdict).toBe("substrate-only");
		// The declared realization survives the reclassification; only the
		// bucket, which is the honesty axis, changes.
		expect(cell.candidates[0]?.realization).toBe("native");
		expect(cell.candidates[0]?.bucket).toBe("substrate");
	});

	it("moves a sponsor-backed product to the sponsor bucket", () => {
		const cell = cellOf(matrix, "bucket/serverless_faas");
		expect(cell.buckets.sponsor.available).toEqual([
			"sponsored.object-store/v1",
		]);
		expect(cell.buckets.native.available).toEqual([]);
		expect(cell.verdict).toBe("sponsor-only");
	});

	it("never lists the same definition in two buckets", () => {
		for (const cell of matrix.cells) {
			const listed = [
				...cell.buckets.native.available,
				...cell.buckets.native.unavailable,
				...cell.buckets.pack.available,
				...cell.buckets.pack.unavailable,
				...cell.buckets.bridge.available,
				...cell.buckets.bridge.unavailable,
				...cell.buckets.substrate.available,
				...cell.buckets.substrate.unavailable,
				...cell.buckets.sponsor.available,
				...cell.buckets.sponsor.unavailable,
			];
			expect(new Set(listed).size).toBe(listed.length);
		}
	});

	it("spans every runtime model a definition declares", () => {
		expect(
			cellOf(matrix, "data/serverless_faas").buckets.native.available,
		).toEqual(["neon.claimable-postgres/v1"]);
		expect(cellOf(matrix, "data/vm_iaas").verdict).toBe("uncovered");
	});
});

describe("evidence state", () => {
	it("covers a cell while its evidence is fresh", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		const cell = cellOf(matrix, "kv/serverless_faas");
		expect(cell.verdict).toBe("covered");
		expect(cell.buckets.native.available).toEqual([EXPIRING.id]);
		expect(cell.candidates[0]?.evidenceState).toBe("fresh");
		expect(cell.candidates[0]?.unavailability).toEqual([]);
	});

	it("demotes the cell once that evidence expires, without deleting the definition", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ nowMs: NOW + 3 * DAY }),
		);
		const cell = cellOf(matrix, "kv/serverless_faas");
		expect(cell.verdict).toBe("evidence-lapsed");
		expect(cell.buckets.native.available).toEqual([]);
		expect(cell.buckets.native.unavailable).toEqual([EXPIRING.id]);
		expect(cell.candidates).toHaveLength(1);
		expect(cell.candidates[0]?.available).toBe(false);
		expect(cell.candidates[0]?.evidenceState).toBe("expired");
		expect(
			cell.candidates[0]?.unavailability.map((reason) => reason.code),
		).toEqual(["evidence-expired"]);
	});

	it("distinguishes a lapsed cell from one nobody ever registered", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ nowMs: NOW + 3 * DAY }),
		);
		expect(cellOf(matrix, "kv/serverless_faas").verdict).toBe(
			"evidence-lapsed",
		);
		expect(cellOf(matrix, "kv/paas").verdict).toBe("uncovered");
	});

	it("holds back a claim that names no conformance suite", () => {
		const matrix = generateCapabilityMatrix(matrixInput());
		const cell = cellOf(matrix, "bucket/oci");
		expect(cell.candidates[0]?.conformanceRef).toBeUndefined();
		expect(cell.candidates[0]?.available).toBe(false);
		expect(
			cell.candidates[0]?.unavailability.map((reason) => reason.code),
		).toEqual(["conformance-ref-missing"]);
		expect(cell.verdict).toBe("evidence-lapsed");
	});

	it("holds back a definition whose evidence was never recorded", () => {
		const matrix = generateCapabilityMatrix(
			matrixInput({ trustEvidence: new Map() }),
		);
		const cell = cellOf(matrix, "data/paas");
		expect(cell.buckets.native.available).toEqual([]);
		expect(cell.buckets.native.unavailable).toEqual([
			"neon.claimable-postgres/v1",
		]);
		expect(cell.candidates[0]?.evidenceState).toBe("absent");
		expect(
			cell.candidates[0]?.unavailability.some(
				(reason) => reason.code === "evidence-absent",
			),
		).toBe(true);
	});
});

describe("claims that reach no cell", () => {
	const matrix = generateCapabilityMatrix(matrixInput());

	it("names an unregistered profile rather than silently dropping it", () => {
		const exclusion = matrix.excluded.find(
			(entry) => entry.definitionId === "ghost.queue/v1",
		);
		expect(exclusion?.code).toBe("unregistered-profile");
		expect(exclusion?.profileId).toBe("queue.unregistered/v1");
		expect(
			matrix.cells
				.filter((cell) => cell.primitive === "queue")
				.every((cell) => cell.candidates.length === 0),
		).toBe(true);
	});

	it("records a legacy definition as contributing nothing", () => {
		const exclusion = matrix.excluded.find(
			(entry) => entry.definitionId === "legacy.port-matched/v1",
		);
		expect(exclusion?.code).toBe("no-declared-semantics");
		expect(exclusion?.profileId).toBe("");
	});

	it("sorts exclusions so the list is a function of content, not of input order", () => {
		const ids = matrix.excluded.map((entry) => entry.definitionId);
		expect([...ids].sort()).toEqual(ids);
	});
});
