import { create } from "@bufbuild/protobuf";
import { FleetCapacitySchema } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	fleetCanAbsorbUnlaunchedRelease,
	fleetCapacityWitness,
	fleetPeerAbsorbSlots,
	fleetWitnessFields,
} from "../src/fleet-capacity-witness.js";

describe("fleet capacity witness", () => {
	it("counts the fleet's free slots beyond this box's own as peers", () => {
		const witness = fleetCapacityWitness(
			1,
			create(FleetCapacitySchema, { freeSlots: 4, totalSlots: 8 }),
		);
		expect(fleetWitnessFields(witness)).toEqual({
			hoboFreeSlots: 1,
			fleetFreeSlots: 4,
			peerAbsorbSlots: 3,
		});
		expect(fleetCanAbsorbUnlaunchedRelease(witness)).toBe(true);
	});

	it("has no peers when the fleet's capacity is unknown or only this box is free", () => {
		expect(fleetPeerAbsorbSlots(fleetCapacityWitness(2, undefined))).toBe(0);
		expect(
			fleetPeerAbsorbSlots(
				fleetCapacityWitness(2, create(FleetCapacitySchema, { freeSlots: 2 })),
			),
		).toBe(0);
		expect(fleetCanAbsorbUnlaunchedRelease(undefined)).toBe(false);
	});

	it("never reports negative peers when this box's view is fresher than the fleet's", () => {
		expect(
			fleetWitnessFields({ hoboFreeSlots: 3, fleetFreeSlots: 1 })
				.peerAbsorbSlots,
		).toBe(0);
	});

	it("treats a fleet count without this box's own as all peers", () => {
		expect(fleetWitnessFields({ fleetFreeSlots: 2 })).toEqual({
			fleetFreeSlots: 2,
			peerAbsorbSlots: 2,
		});
	});
});
