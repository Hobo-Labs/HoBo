import { describe, expect, it } from "vitest";
import {
	fleetCanAbsorbUnlaunchedRelease,
	fleetPeerAbsorbSlots,
	fleetWitnessFields,
} from "../src/fleet-absorb.js";

describe("fleet absorb", () => {
	it("treats arc slots as peer capacity", () => {
		expect(fleetPeerAbsorbSlots({ hoboFreeSlots: 0, arcFreeSlots: 2 })).toBe(2);
		expect(fleetCanAbsorbUnlaunchedRelease({ arcFreeSlots: 1 })).toBe(true);
	});

	it("uses mesh free minus local hobo when arc is under-reported", () => {
		expect(
			fleetPeerAbsorbSlots({
				hoboFreeSlots: 1,
				arcFreeSlots: 0,
				meshFreeSlots: 4,
			}),
		).toBe(3);
	});

	it("fail-closes when witness is missing", () => {
		expect(fleetCanAbsorbUnlaunchedRelease(undefined)).toBe(false);
		expect(fleetPeerAbsorbSlots(undefined)).toBe(0);
		expect(fleetWitnessFields(undefined).hoboFreeSlots).toBeUndefined();
	});

	it("omits a fabricated zero hobo slot count when witness is missing", () => {
		const fields = fleetWitnessFields(undefined);
		expect(fields).toMatchObject({
			arcFreeSlots: 0,
			meshFreeSlots: 0,
			peerAbsorbSlots: 0,
		});
		expect(fields.hoboFreeSlots).toBeUndefined();
	});
});
