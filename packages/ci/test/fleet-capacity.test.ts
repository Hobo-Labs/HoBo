import { describe, expect, it } from "vitest";
import {
	buildFleetCapacitySnapshot,
	fleetCapacityVariableValue,
	memoryAdmitHeadroom,
	parseFleetCapacityVariable,
} from "../src/fleet/capacity.js";

describe("fleet capacity", () => {
	it("refuses admit when available memory is below reserve + job + volatility", () => {
		expect(memoryAdmitHeadroom(4096, 4096, 2048, 1024)).toBe(false);
		expect(memoryAdmitHeadroom(7168, 4096, 2048, 1024)).toBe(true);
	});

	it("round-trips the published repository variable", () => {
		const snapshot = buildFleetCapacitySnapshot({
			atMs: 1_700_000_000_000,
			availableMb: 2400,
			reserveMb: 2048,
			volatilityMb: 1024,
			freeSlotsHobo: 2,
			freeSlotsTrunk: 1,
			requiredMbHobo: 3072,
			requiredMbTrunk: 4096,
		});
		expect(snapshot["hobo-trunk"].admit).toBe(false);
		const parsed = parseFleetCapacityVariable(
			fleetCapacityVariableValue(snapshot),
		);
		expect(parsed?.["hobo-trunk"].admit).toBe(false);
	});
});
