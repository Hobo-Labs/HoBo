/**
 * `fleetView` and `fleetVerdict` (design §6.8 "Fleet view and verdict"),
 * moved from `packages/ci/test/mesh-report.test.ts` and `mesh-monitor.test.ts`:
 * one entry per member with its state since when, capacity that counts only
 * live, healthy, active members, and the per-label answer runner routing
 * needs. The capacity monitor's transitions are logged as `hobo_fleet_*`.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Availability,
	FleetCapacitySchema,
	type FleetView,
	FleetViewSchema,
	Health,
	MemberState,
	MembershipSchema,
	ReliabilitySamplesSchema,
	Role,
	VerdictState,
} from "../../src/_generated/fleet_pb.js";
import { type MemberId, parseMemberId } from "../../src/ids.js";
import { fleetVerdict, fleetView } from "../../src/observation/index.js";
import { createCapacityMonitor } from "../../src/observation/monitor.js";
import type { FleetLogEvent } from "../../src/ports.js";
import { parseFleetVerdict } from "../../src/verdict-wire.js";
import {
	FLEET,
	fleetRecord,
	iso,
	NOW,
	observation,
	sponsoredRecord,
} from "./fixtures.js";

const id = (n: number): MemberId =>
	parseMemberId(`dev_${n.toString(16).padStart(32, "0")}`);

function device(
	n: number,
	overrides: Parameters<typeof sponsoredRecord>[2] = {},
) {
	return sponsoredRecord(id(n), "", {
		kind: 1,
		displayName: `box ${n}`,
		memberships: [
			create(MembershipSchema, {
				fleet: FLEET,
				name: `box-${n}`,
				roles: [Role.EXECUTOR],
			}),
		],
		...overrides,
	});
}

describe("fleetView", () => {
	it("lists each member with its availability, health and capacity since when", () => {
		const members = [device(1), device(2), device(3), device(4)];
		const view = fleetView(
			fleetRecord(),
			members,
			[
				observation(id(1), {
					capacity: { freeSlots: 2, totalSlots: 4, freeMemoryMb: 8_000 },
				}),
				observation(id(2), {
					health: Health.DRAINING,
					failingForMs: 0,
					since: iso(NOW - 5_000),
				}),
				observation(id(3), { validUntil: iso(NOW - 10_000) }),
			],
			new Map([
				[
					id(1),
					create(ReliabilitySamplesSchema, { delivered: 0, dropped: 10 }),
				],
			]),
			NOW,
		);
		expect(view.fleet).toBe(FLEET);
		expect(view.asOf).toBe(iso(NOW));
		expect(view.notAfter).toBe(iso(NOW + 120_000));
		expect(view.truncated).toBe(false);
		const [one, two, three, four] = view.members;
		expect(one).toMatchObject({
			memberId: id(1),
			name: "box-1",
			displayName: "box 1",
			state: MemberState.ACTIVE,
			availability: Availability.LIVE,
			health: Health.REACHABLE,
			capacity: { freeSlots: 2, totalSlots: 4, freeMemoryMb: 8_000 },
			labels: ["hobo"],
			roles: [Role.EXECUTOR],
			since: iso(NOW - 60_000),
			lastSeen: iso(NOW),
			samples: { delivered: 0, dropped: 10 },
		});
		expect(one?.reliability).toBeCloseTo(4 / 14, 10);
		expect(two).toMatchObject({
			availability: Availability.UNHEALTHY,
			health: Health.DRAINING,
			since: iso(NOW - 5_000),
		});
		expect(two?.reliability).toBeUndefined();
		// Its last observation expired: lost since then, health no longer known.
		expect(three).toMatchObject({
			availability: Availability.LOST,
			health: Health.UNKNOWN,
			since: iso(NOW - 10_000),
			lastSeen: iso(NOW),
		});
		// Never observed: lost, with nothing to say since when.
		expect(four).toMatchObject({
			availability: Availability.LOST,
			health: Health.UNKNOWN,
			since: "",
		});
	});

	it("counts capacity over live, healthy, active members only", () => {
		const view = fleetView(
			fleetRecord(),
			[
				device(1),
				device(2),
				device(3),
				device(4, { state: MemberState.SUSPENDED }),
				device(5),
			],
			[
				observation(id(1), {
					capacity: {
						freeSlots: 2,
						totalSlots: 4,
						freeMemoryMb: 8_000,
						freeDiskMb: 100,
					},
				}),
				observation(id(2), {
					capacity: { freeSlots: 1, freeMemoryMb: 12_000 },
				}),
				observation(id(3), {
					health: Health.PRESSURED,
					capacity: { freeSlots: 9 },
				}),
				observation(id(4), { capacity: { freeSlots: 9 } }),
				// Another fleet's observation says nothing about this one.
				observation(id(5), { fleets: ["other"], capacity: { freeSlots: 9 } }),
			],
			new Map(),
			NOW,
		);
		expect(view.capacity).toEqual(
			create(FleetCapacitySchema, {
				live: 3,
				healthy: 2,
				totalSlots: 5,
				freeSlots: 3,
				freeMemoryMb: 20_000,
				freeDiskMb: 100,
				maxMemoryMb: 12_000,
			}),
		);
	});

	it("leaves memory and disk unknown when no healthy member reports them", () => {
		const view = fleetView(
			fleetRecord(),
			[device(1)],
			[observation(id(1))],
			new Map(),
			NOW,
		);
		expect(view.capacity?.freeMemoryMb).toBeUndefined();
		expect(view.capacity?.freeDiskMb).toBeUndefined();
		expect(view.capacity?.maxMemoryMb).toBeUndefined();
	});

	it("uses each member's newest observation, and only members of this fleet", () => {
		const view = fleetView(
			fleetRecord(),
			[
				device(1),
				device(2, {
					memberships: [
						create(MembershipSchema, { fleet: "other", name: "x" }),
					],
				}),
			],
			[
				observation(id(1), { issuedAt: iso(NOW), capacity: { freeSlots: 5 } }),
				observation(id(1), {
					issuedAt: iso(NOW - 1_000),
					capacity: { freeSlots: 1 },
				}),
			],
			new Map(),
			NOW,
		);
		expect(view.members.map((entry) => entry.memberId)).toEqual([id(1)]);
		expect(view.capacity?.freeSlots).toBe(5);
	});

	it("lists at most 256 members, active first, and says it truncated; capacity covers them all", () => {
		const members = Array.from({ length: 300 }, (_, index) =>
			device(index + 1, {
				state: index < 10 ? MemberState.SUSPENDED : MemberState.ACTIVE,
			}),
		);
		const view = fleetView(
			fleetRecord(),
			members,
			members.map((entry) => observation(entry.memberId)),
			new Map(),
			NOW,
		);
		expect(view.members).toHaveLength(256);
		expect(view.truncated).toBe(true);
		expect(
			view.members.every((entry) => entry.state === MemberState.ACTIVE),
		).toBe(true);
		expect(view.capacity?.live).toBe(290);
		expect(view.capacity?.freeSlots).toBe(580);
	});
});

describe("fleetVerdict", () => {
	const view = (
		...observations: Parameters<typeof observation>[1][]
	): FleetView =>
		fleetView(
			fleetRecord(),
			observations.map((_, index) => device(index + 1)),
			observations.map((overrides, index) =>
				observation(id(index + 1), overrides),
			),
			new Map(),
			NOW,
		);

	it("is OPEN with the free slots of live members serving the label", () => {
		const verdict = fleetVerdict(
			view(
				{ capacity: { freeSlots: 2 } },
				{ capacity: { freeSlots: 3 } },
				{ capacity: { freeSlots: 7 }, labels: ["hobo-trunk"] },
				{ capacity: { freeSlots: 7 }, health: Health.DRAINING },
			),
			"hobo",
			NOW,
		);
		expect(verdict).toMatchObject({
			fleet: FLEET,
			label: "hobo",
			state: VerdictState.OPEN,
			members: 2,
			freeSlots: 5,
			asOf: iso(NOW),
		});
	});

	it("is NO_MEMBER when nobody live serves the label, NO_CAPACITY when they are full", () => {
		expect(
			fleetVerdict(view({ labels: ["hobo-trunk"] }), "hobo", NOW).state,
		).toBe(VerdictState.NO_MEMBER);
		expect(
			fleetVerdict(view({ validUntil: iso(NOW - 1) }), "hobo", NOW).state,
		).toBe(VerdictState.NO_MEMBER);
		expect(
			fleetVerdict(view({ capacity: { freeSlots: 0 } }), "hobo", NOW),
		).toMatchObject({ state: VerdictState.NO_CAPACITY, members: 1 });
	});

	it("expires at most 300 seconds after it was made, and no later than its view", () => {
		const fresh = fleetVerdict(view({}), "hobo", NOW);
		expect(fresh.expiresAt).toBe(iso(NOW + 120_000));
		const long = create(FleetViewSchema, {
			...view({}),
			notAfter: iso(NOW + 3_600_000),
		});
		expect(fleetVerdict(long, "hobo", NOW).expiresAt).toBe(iso(NOW + 300_000));
		// A stale view gives a verdict that has already expired.
		const stale = fleetVerdict(view({}), "hobo", NOW + 200_000);
		expect(stale.expiresAt).toBe(stale.asOf);
	});

	it("falls back to the fleet's capacity when a truncated list shows nobody for the label", () => {
		const partial = create(FleetViewSchema, {
			...view({ labels: ["hobo-trunk"] }),
			truncated: true,
			capacity: create(FleetCapacitySchema, { healthy: 40, freeSlots: 12 }),
		});
		expect(fleetVerdict(partial, "hobo", NOW)).toMatchObject({
			state: VerdictState.OPEN,
			members: 40,
			freeSlots: 12,
		});
	});

	it("round-trips through the verdict wire as protobuf JSON", () => {
		const verdict = fleetVerdict(
			view({ capacity: { freeSlots: 3 } }),
			"hobo",
			NOW,
		);
		const json = JSON.stringify({
			fleet: verdict.fleet,
			label: verdict.label,
			state: VerdictState[verdict.state] === "OPEN" ? "VERDICT_STATE_OPEN" : "",
			members: verdict.members,
			freeSlots: verdict.freeSlots,
			asOf: verdict.asOf,
			expiresAt: verdict.expiresAt,
		});
		expect(parseFleetVerdict(json, NOW)).toEqual({
			state: "OPEN",
			freeSlots: 3,
		});
	});
});

describe("createCapacityMonitor", () => {
	const capacity = (live: number, freeSlots: number) =>
		create(FleetCapacitySchema, { live, healthy: live, freeSlots });

	it("logs exhaustion and restoration once each, and a summary on change or every minute", () => {
		const logged: FleetLogEvent[] = [];
		const monitor = createCapacityMonitor({
			summaryEveryMs: 60_000,
			log: (event) => logged.push(event),
		});
		monitor.observe(capacity(2, 4), NOW);
		monitor.observe(capacity(2, 4), NOW + 1_000);
		monitor.observe(capacity(2, 0), NOW + 2_000);
		monitor.observe(capacity(2, 0), NOW + 3_000);
		monitor.observe(capacity(2, 1), NOW + 4_000);
		monitor.observe(capacity(2, 1), NOW + 70_000);
		// An empty fleet is not "exhausted": there is nobody to wait for.
		monitor.observe(capacity(0, 0), NOW + 71_000);
		expect(logged).toEqual([
			"hobo_fleet_capacity",
			"hobo_fleet_capacity_exhausted",
			"hobo_fleet_capacity",
			"hobo_fleet_capacity_restored",
			"hobo_fleet_capacity",
			"hobo_fleet_capacity",
		]);
	});
});
