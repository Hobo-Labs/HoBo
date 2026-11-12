import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseFleetCapacityPublished,
	resolveMainWorkspaceShardRunner,
} from "../ci/load-fleet-capacity.mts";

describe("load-fleet-capacity", () => {
	it("resolves shard runner: ARC preferred", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 2,
				hobo: { freeSlots: 1 },
				arc: { freeSlots: 1 },
				trunkMemoryAdmit: false,
			}),
		);
		assert.ok(snapshot);
		assert.equal(resolveMainWorkspaceShardRunner(snapshot), "hobo-trunk");
	});

	it("resolves shard runner: hosted when no ARC and memory blocks trunk", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 1,
				hobo: { freeSlots: 1 },
				arc: { freeSlots: 0 },
				trunkMemoryAdmit: false,
			}),
		);
		assert.ok(snapshot);
		assert.equal(resolveMainWorkspaceShardRunner(snapshot), "hobo");
	});

	it("parses trunkMemoryAdmit on capacity snapshots", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 4,
				trunkMemoryAdmit: true,
				hobo: { freeSlots: 2 },
				arc: { freeSlots: 0 },
			}),
		);
		assert.deepEqual(snapshot?.trunkMemoryAdmit, true);
	});
});
