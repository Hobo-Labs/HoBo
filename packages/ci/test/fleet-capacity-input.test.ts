import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	fleetCapacitySnapshot,
	fleetCapacityVariableValue,
	mainWorkspaceParallelCap,
	parseFleetCapacityPublished,
	resolveMainWorkspaceShardRunner,
} from "../src/fleet/capacity-input.js";

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

	it("round-trips trunkMemoryAdmit through fleet capacity JSON", () => {
		const text = fleetCapacityVariableValue(
			fleetCapacitySnapshot(1, 0, "2026-11-12T00:00:00Z", false),
		);
		const parsed = parseFleetCapacityPublished(text);
		expect(parsed?.trunkMemoryAdmit).toBe(false);
		expect(resolveMainWorkspaceShardRunner(parsed)).toBe("hobo");
	});

	it("resolves main workspace shard runner from capacity", () => {
		expect(
			resolveMainWorkspaceShardRunner(
				fleetCapacitySnapshot(1, 2, undefined, false),
			),
		).toBe("hobo-trunk");
		expect(
			resolveMainWorkspaceShardRunner(
				fleetCapacitySnapshot(1, 0, undefined, false),
			),
		).toBe("hobo");
	});

	it("falls back when the variable is missing or invalid", () => {
		expect(mainWorkspaceParallelCap(undefined)).toBe(
			DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
		);
		expect(parseFleetCapacityPublished("")).toBeUndefined();
		expect(parseFleetCapacityPublished("not-json")).toBeUndefined();
	});
});
