import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	FLEET_CAPACITY_MAX_AGE_MS,
	fleetCapacitySnapshot,
	fleetCapacityVariableValue,
	isFleetCapacityFresh,
	mainWorkspaceParallelCap,
	parseFleetCapacityPublished,
	resolveMainWorkspaceShardRunners,
} from "../src/fleet/capacity-input.js";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const FRESH_AT = new Date(NOW - 60_000).toISOString();
const STALE_AT = new Date(NOW - FLEET_CAPACITY_MAX_AGE_MS - 1).toISOString();

describe("fleet capacity input", () => {
	it("builds admitted parallel as hobo plus arc capped at eight", () => {
		expect(fleetCapacitySnapshot(3, 1)).toEqual({
			version: 1,
			admittedParallel: 4,
			hobo: { freeSlots: 3 },
			arc: { freeSlots: 1 },
		});
		expect(fleetCapacitySnapshot(6, 4).admittedParallel).toBe(8);
	});

	it("parses published JSON and resolves the main parallel cap", () => {
		const text = fleetCapacityVariableValue(
			fleetCapacitySnapshot(2, 1, "2026-11-11T02:00:00Z"),
		);
		const parsed = parseFleetCapacityPublished(text);
		expect(parsed?.admittedParallel).toBe(3);
		expect(mainWorkspaceParallelCap(parsed)).toBe(3);
	});

	it("per-shard runners: ARC first, ubuntu-24.04 overflow, stale holds trunk", () => {
		const freshBlocked = fleetCapacitySnapshot(1, 1, FRESH_AT, false);
		expect(resolveMainWorkspaceShardRunners(3, freshBlocked, NOW)).toEqual([
			{ shard: 0, runner: "hobo-trunk" },
			{ shard: 1, runner: "ubuntu-24.04" },
			{ shard: 2, runner: "ubuntu-24.04" },
		]);
		const stale = fleetCapacitySnapshot(0, 0, STALE_AT, false);
		expect(isFleetCapacityFresh(stale, NOW)).toBe(false);
		const future = fleetCapacitySnapshot(1, 1, new Date(NOW + 60_000).toISOString());
		expect(isFleetCapacityFresh(future, NOW)).toBe(false);
		expect(resolveMainWorkspaceShardRunners(2, stale, NOW)).toEqual([
			{ shard: 0, runner: "hobo-trunk" },
			{ shard: 1, runner: "hobo-trunk" },
		]);
	});

	it("falls back when the variable is missing or invalid", () => {
		expect(mainWorkspaceParallelCap(undefined)).toBe(
			DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
		);
		expect(parseFleetCapacityPublished("")).toBeUndefined();
		expect(parseFleetCapacityPublished("not-json")).toBeUndefined();
	});
});
