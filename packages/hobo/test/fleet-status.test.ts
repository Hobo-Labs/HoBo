/**
 * The `hobo fleet status` table in its less common states, and the live bus
 * the oci-command source reads through while the agent reconnects.
 */
import { create } from "@bufbuild/protobuf";
import {
	Availability,
	type FleetBus,
	FleetViewSchema,
	Health,
	MemberState,
	SandboxTier,
} from "@hobo/fleet";
import { createMemoryBus } from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { liveBus } from "../src/fleet-runtime.js";
import { fleetStatusTable } from "../src/fleet-status.js";

describe("the fleet status table", () => {
	it("says when there are no fleets, or no view", () => {
		expect(fleetStatusTable([])).toBe("No fleets.");
		expect(fleetStatusTable([{ fleet: "f", view: undefined }])).toBe(
			"Fleet f: the authority returned no view.",
		);
	});

	it("hides a lost member's figures and names every state", () => {
		const view = create(FleetViewSchema, {
			fleet: "f",
			asOf: "now",
			truncated: true,
			members: [
				{
					memberId: "m_lost",
					state: MemberState.SUSPENDED,
					availability: Availability.LOST,
					health: Health.UNREACHABLE,
					capacity: { freeSlots: 9, totalSlots: 9, freeMemoryMb: 200_000 },
					reliability: 0.5,
					sandboxTiers: [SandboxTier.S3_MICROVM],
				},
				{
					name: "big",
					state: MemberState.LOCKED,
					availability: Availability.UNHEALTHY,
					health: Health.QUOTA_EXHAUSTED,
					capacity: { freeSlots: 1, freeMemoryMb: 200_000, freeDiskMb: 4096 },
				},
				{ name: "bare" },
			],
		});
		const lines = fleetStatusTable([{ fleet: "f", view }]).split("\n");
		expect(lines[2]).toMatch(
			/^m_lost\s+suspended\s+lost\s+unreachable\s+-\s+-\s+-\s+0\.50\s+S3$/,
		);
		expect(lines[3]).toMatch(
			/^big\s+locked\s+unhealthy\s+quota-exhausted\s+1\/\?\s+195 GB\s+4\.0 GB\s+-\s+-$/,
		);
		expect(lines[4]).toMatch(/^bare(\s+-){8}$/);
		expect(lines[5]).toBe("More members are known than are listed; 3 shown.");
	});
});

describe("the live bus", () => {
	it("reads through to the connection the agent holds, and refuses without one", async () => {
		let current: FleetBus | undefined;
		const bus = liveBus(() => current);
		expect(bus.status()).toBe("disconnected");
		expect(() => bus.registry).toThrow("not connected");
		const memory = createMemoryBus(() => 0);
		current = memory;
		expect(bus.registry).toBe(memory.registry);
		expect(bus.observations).toBe(memory.observations);
		expect(bus.claims).toBe(memory.claims);
		expect(bus.offers).toBe(memory.offers);
		expect(bus.submissions).toBe(memory.submissions);
		expect(bus.orders).toBe(memory.orders);
		expect(bus.events).toBe(memory.events);
		expect(bus.control).toBe(memory.control);
		expect(bus.relay).toBe(memory.relay);
		expect(bus.status()).toBe(memory.status());
		await bus.close();
		expect(memory.status()).not.toBe("closed");
	});
});
