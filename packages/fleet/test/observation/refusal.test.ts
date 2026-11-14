/**
 * `deriveRefusal` (amendment 4, D60; ADR-0181 R4): why a member admits no new
 * work, in the order draining, storage, pressure, its own work. Thresholds are
 * main's box worker's (`isolated-worker/host-capacity.ts`,
 * `storage-admission.ts`) and L10's memory reserve.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CapacitySchema,
	Health,
	Refusal,
} from "../../src/_generated/fleet_pb.js";
import {
	deriveRefusal,
	hostSignalsOf,
	PSI_MEMORY_FULL_LIMIT,
	PSI_MEMORY_SOME_LIMIT,
	publishedHealth,
	STORAGE_FLOOR_DISK_MB,
	STORAGE_FLOOR_INODES,
} from "../../src/observation/refusal.js";

const roomy = {
	freeSlots: 2,
	totalSlots: 2,
	freeMemoryMb: 8_000,
	freeDiskMb: 50_000,
};
const capacity = (overrides: Partial<typeof roomy> = {}) =>
	create(CapacitySchema, { ...roomy, ...overrides });
const input = (
	overrides: Partial<Parameters<typeof deriveRefusal>[0]> = {},
): Parameters<typeof deriveRefusal>[0] => ({
	draining: false,
	health: Health.REACHABLE,
	capacity: capacity(),
	host: { freeInodes: 1_000_000, psiMemorySome: 0, psiMemoryFull: 0 },
	...overrides,
});

describe("deriveRefusal", () => {
	it("is NONE when the member admits work", () => {
		expect(deriveRefusal(input())).toBe(Refusal.NONE);
		expect(deriveRefusal(input({ host: {} }))).toBe(Refusal.NONE);
	});

	it("is DRAINING first, whatever else holds", () => {
		expect(
			deriveRefusal(
				input({
					draining: true,
					capacity: capacity({ freeSlots: 0, freeDiskMb: 0, freeMemoryMb: 0 }),
				}),
			),
		).toBe(Refusal.DRAINING);
	});

	it("is STORAGE when disk bytes or inodes are under the floor, before pressure", () => {
		expect(
			deriveRefusal(
				input({
					capacity: capacity({ freeDiskMb: STORAGE_FLOOR_DISK_MB - 1 }),
				}),
			),
		).toBe(Refusal.STORAGE);
		expect(
			deriveRefusal(input({ host: { freeInodes: STORAGE_FLOOR_INODES - 1 } })),
		).toBe(Refusal.STORAGE);
		expect(
			deriveRefusal(
				input({
					capacity: capacity({ freeDiskMb: 0, freeMemoryMb: 0 }),
					health: Health.PRESSURED,
				}),
			),
		).toBe(Refusal.STORAGE);
		expect(
			deriveRefusal(
				input({
					capacity: capacity({ freeDiskMb: STORAGE_FLOOR_DISK_MB }),
					host: { freeInodes: STORAGE_FLOOR_INODES },
				}),
			),
		).toBe(Refusal.NONE);
	});

	it("is PRESSURE when no memory is left above the reserve, the source is pressured, or PSI is over its limit", () => {
		expect(
			deriveRefusal(input({ capacity: capacity({ freeMemoryMb: 0 }) })),
		).toBe(Refusal.PRESSURE);
		expect(deriveRefusal(input({ health: Health.PRESSURED }))).toBe(
			Refusal.PRESSURE,
		);
		expect(
			deriveRefusal(input({ host: { psiMemorySome: PSI_MEMORY_SOME_LIMIT } })),
		).toBe(Refusal.PRESSURE);
		expect(
			deriveRefusal(input({ host: { psiMemoryFull: PSI_MEMORY_FULL_LIMIT } })),
		).toBe(Refusal.PRESSURE);
		expect(
			deriveRefusal(
				input({
					host: {
						psiMemorySome: PSI_MEMORY_SOME_LIMIT - 0.01,
						psiMemoryFull: PSI_MEMORY_FULL_LIMIT - 0.01,
					},
				}),
			),
		).toBe(Refusal.NONE);
	});

	it("is OWN_WORK when every slot is taken and nothing else refuses", () => {
		expect(deriveRefusal(input({ capacity: capacity({ freeSlots: 0 }) }))).toBe(
			Refusal.OWN_WORK,
		);
		expect(
			deriveRefusal(
				input({ capacity: capacity({ freeSlots: 0, freeMemoryMb: 0 }) }),
			),
		).toBe(Refusal.PRESSURE);
	});

	it("says nothing when capacity is unknown or the member has no slots at all", () => {
		expect(deriveRefusal(input({ capacity: undefined }))).toBe(
			Refusal.UNSPECIFIED,
		);
		expect(
			deriveRefusal(
				input({ capacity: capacity({ freeSlots: 0, totalSlots: 0 }) }),
			),
		).toBe(Refusal.UNSPECIFIED);
	});

	it("treats absent figures as unknown, never as under a threshold", () => {
		expect(
			deriveRefusal(
				input({
					capacity: create(CapacitySchema, { freeSlots: 1 }),
					host: {},
				}),
			),
		).toBe(Refusal.NONE);
	});
});

describe("publishedHealth", () => {
	it("is DRAINING while draining, PRESSURED for pressure or storage, else the source's", () => {
		expect(publishedHealth(Refusal.DRAINING, Health.REACHABLE)).toBe(
			Health.DRAINING,
		);
		expect(publishedHealth(Refusal.STORAGE, Health.REACHABLE)).toBe(
			Health.PRESSURED,
		);
		expect(publishedHealth(Refusal.PRESSURE, Health.REACHABLE)).toBe(
			Health.PRESSURED,
		);
		expect(publishedHealth(Refusal.OWN_WORK, Health.REACHABLE)).toBe(
			Health.REACHABLE,
		);
		expect(publishedHealth(Refusal.UNSPECIFIED, undefined)).toBe(
			Health.UNKNOWN,
		);
	});
});

describe("hostSignalsOf", () => {
	const bare = { capacity: capacity(), health: Health.REACHABLE, labels: [] };
	const reading = (
		hostSignals: Readonly<Record<string, number | string>> | string,
	) => ({ ...bare, hostSignals });

	it("reads the host signals a capacity reading carries beside the port's fields", () => {
		expect(
			hostSignalsOf(
				reading({ freeInodes: 7, psiMemorySome: 1.5, psiMemoryFull: 0 }),
			),
		).toEqual({ freeInodes: 7, psiMemorySome: 1.5, psiMemoryFull: 0 });
	});

	it("ignores anything that is not a finite, non-negative number", () => {
		expect(hostSignalsOf(undefined)).toEqual({});
		expect(hostSignalsOf(bare)).toEqual({});
		expect(hostSignalsOf(reading("signals"))).toEqual({});
		expect(
			hostSignalsOf(
				reading({
					freeInodes: -1,
					psiMemorySome: Number.NaN,
					psiMemoryFull: "3",
				}),
			),
		).toEqual({});
	});
});
