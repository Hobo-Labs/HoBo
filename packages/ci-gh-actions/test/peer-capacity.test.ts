import { create } from "@bufbuild/protobuf";
import { FleetCapacitySchema } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	peerAbsorbSlotsOf,
	peerCapacityWitness,
	peersCanAbsorbUnlaunchedRelease,
	peerWitnessFields,
} from "../src/peer-capacity.js";

describe("peer capacity witness", () => {
	it("counts the fleet's free slots beyond this box's own as peers", () => {
		const witness = peerCapacityWitness(
			1,
			create(FleetCapacitySchema, { freeSlots: 4, totalSlots: 8 }),
		);
		expect(peerWitnessFields(witness)).toEqual({
			hoboFreeSlots: 1,
			fleetFreeSlots: 4,
			peerAbsorbSlots: 3,
		});
		expect(peersCanAbsorbUnlaunchedRelease(witness)).toBe(true);
	});

	it("has no peers when the fleet's capacity is unknown or only this box is free", () => {
		expect(peerAbsorbSlotsOf(peerCapacityWitness(2, undefined))).toBe(0);
		expect(
			peerAbsorbSlotsOf(
				peerCapacityWitness(2, create(FleetCapacitySchema, { freeSlots: 2 })),
			),
		).toBe(0);
		expect(peersCanAbsorbUnlaunchedRelease(undefined)).toBe(false);
	});

	it("never reports negative peers when this box's view is fresher than the fleet's", () => {
		expect(
			peerWitnessFields({ hoboFreeSlots: 3, fleetFreeSlots: 1 })
				.peerAbsorbSlots,
		).toBe(0);
	});

	it("treats a fleet count without this box's own as all peers", () => {
		expect(peerWitnessFields({ fleetFreeSlots: 2 })).toEqual({
			fleetFreeSlots: 2,
			peerAbsorbSlots: 2,
		});
	});
});
