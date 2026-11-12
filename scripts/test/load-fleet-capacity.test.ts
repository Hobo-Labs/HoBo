import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FLEET_CAPACITY_MAX_AGE_MS,
	isFleetCapacityFresh,
	mainGateShardCountFromIndexesJson,
	parseFleetCapacityPublished,
	resolveMainWorkspaceParallelCap,
	resolveMainWorkspaceShardRunner,
	resolveMainWorkspaceShardRunners,
} from "../ci/load-fleet-capacity.mts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const FRESH_AT = new Date(NOW - 60_000).toISOString();

describe("load-fleet-capacity", () => {
	it("resolves per-shard runners: ARC slots then ubuntu-24.04", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 2,
				hobo: { freeSlots: 1 },
				arc: { freeSlots: 1 },
				trunkMemoryAdmit: false,
				publishedAt: FRESH_AT,
			}),
		);
		assert.ok(snapshot);
		assert.equal(resolveMainWorkspaceShardRunner(snapshot), "hobo-trunk");
		assert.deepEqual(resolveMainWorkspaceShardRunners(3, snapshot, NOW), [
			{ shard: 0, runner: "hobo-trunk" },
			{ shard: 1, runner: "ubuntu-24.04" },
			{ shard: 2, runner: "ubuntu-24.04" },
		]);
	});

	it("stale publishedAt holds overflow on hobo-trunk", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 1,
				hobo: { freeSlots: 1 },
				arc: { freeSlots: 0 },
				trunkMemoryAdmit: false,
				publishedAt: new Date(
					NOW - FLEET_CAPACITY_MAX_AGE_MS - 1,
				).toISOString(),
			}),
		);
		assert.ok(snapshot);
		assert.equal(isFleetCapacityFresh(snapshot, NOW), false);
		assert.deepEqual(resolveMainWorkspaceShardRunners(2, snapshot, NOW), [
			{ shard: 0, runner: "hobo-trunk" },
			{ shard: 1, runner: "hobo-trunk" },
		]);
	});

	it("rejects snapshots with malformed arc.freeSlots", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 2,
				hobo: { freeSlots: 1 },
				arc: { freeSlots: "bad" },
				publishedAt: FRESH_AT,
			}),
		);
		assert.equal(snapshot, undefined);
	});

	it("stale capacity falls back to default parallel cap", async () => {
		const stale = JSON.stringify({
			version: 1,
			admittedParallel: 8,
			hobo: { freeSlots: 4 },
			arc: { freeSlots: 4 },
			publishedAt: new Date(NOW - FLEET_CAPACITY_MAX_AGE_MS - 1).toISOString(),
		});
		const previous = process.env.HOBO_CI_FLEET_CAPACITY_JSON;
		process.env.HOBO_CI_FLEET_CAPACITY_JSON = stale;
		try {
			const cap = await resolveMainWorkspaceParallelCap({});
			assert.equal(cap, 4);
		} finally {
			if (previous === undefined) {
				delete process.env.HOBO_CI_FLEET_CAPACITY_JSON;
			} else {
				process.env.HOBO_CI_FLEET_CAPACITY_JSON = previous;
			}
		}
	});

	it("validates contiguous shard index lists", () => {
		assert.equal(mainGateShardCountFromIndexesJson("[]"), 0);
		assert.equal(mainGateShardCountFromIndexesJson("[0, 1, 2]"), 3);
		assert.equal(mainGateShardCountFromIndexesJson("[0,0,9]"), -1);
	});

	it("parses trunkMemoryAdmit on capacity snapshots", () => {
		const snapshot = parseFleetCapacityPublished(
			JSON.stringify({
				version: 1,
				admittedParallel: 4,
				trunkMemoryAdmit: true,
				hobo: { freeSlots: 2 },
				arc: { freeSlots: 0 },
				publishedAt: FRESH_AT,
			}),
		);
		assert.deepEqual(snapshot?.trunkMemoryAdmit, true);
	});
});
