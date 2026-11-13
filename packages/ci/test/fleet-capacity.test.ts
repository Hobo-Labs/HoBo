import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	memoryAdmitHeadroom,
	memoryAdmitParallelCount,
} from "../src/fleet/capacity.js";
import * as root from "../src/index.js";

describe("fleet capacity", () => {
	it("refuses admit when available memory is below reserve + job + volatility", () => {
		expect(memoryAdmitHeadroom(4096, 4096, 2048, 1024)).toBe(false);
		expect(memoryAdmitHeadroom(7168, 4096, 2048, 1024)).toBe(true);
	});

	it("counts parallel standard jobs from OS headroom", () => {
		const reserve = 2048;
		const volatility = 1024;
		const request = 4096;
		expect(
			memoryAdmitParallelCount(9_932, request, reserve, volatility, 8),
		).toBe(1);
		expect(
			memoryAdmitParallelCount(20_480, request, reserve, volatility, 8),
		).toBe(4);
		expect(
			memoryAdmitParallelCount(11_264, request, reserve, volatility, 3),
		).toBe(2);
	});
});

// Plan 0025, section 6.8: the HOBO_CI_FLEET_CAPACITY record is retired;
// whether the fleet can take a run is the relay's to decide (ADR-0180).
describe("the retired capacity record", () => {
	it("is no longer exported or defined", () => {
		const exported = Object.keys(root);
		for (const name of [
			"FLEET_CAPACITY_VARIABLE",
			"fleetCapacitySnapshot",
			"fleetCapacityVariableValue",
			"parseFleetCapacityPublished",
			"mainWorkspaceParallelCap",
		])
			expect(exported).not.toContain(name);
		expect(
			existsSync(new URL("../src/fleet/capacity-input.ts", import.meta.url)),
		).toBe(false);
	});
});
