/**
 * `fitWork` (design §6.8), moved from `fitJob` in
 * `packages/ci/test/mesh-rendezvous.test.ts`: how many copies of this work a
 * device could start, or the first thing it lacks. An absent figure is
 * unknown and constrains nothing; an absent sandbox tier is not assumed.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	Health,
	type Observation,
	ObservationSchema,
	SandboxTier,
	type WorkNeeds,
	WorkNeedsSchema,
} from "../../src/_generated/fleet_pb.js";
import { fitWork } from "../../src/observation/index.js";

type ObservationInit = Exclude<
	Parameters<typeof create<typeof ObservationSchema>>[1],
	Observation | undefined
>;
type NeedsInit = Exclude<
	Parameters<typeof create<typeof WorkNeedsSchema>>[1],
	WorkNeeds | undefined
>;

const device = (overrides: ObservationInit = {}): Observation =>
	create(ObservationSchema, {
		health: Health.REACHABLE,
		capacity: { freeSlots: 2 },
		labels: ["hobo"],
		platform: { os: "linux", arch: "x64" },
		sandboxTiers: [SandboxTier.S1_CONTAINER],
		...overrides,
	});
const needs = (overrides: NeedsInit = {}): WorkNeeds =>
	create(WorkNeedsSchema, { labels: ["hobo"], ...overrides });

describe("fitWork", () => {
	it("counts the copies that fit, bounded by slots, memory and disk", () => {
		const roomy = device({ capacity: { freeSlots: 4, freeMemoryMb: 32_768 } });
		const tight = device({ capacity: { freeSlots: 4, freeMemoryMb: 7_000 } });
		expect(fitWork(roomy, needs({ memoryMb: 6_144 }))).toEqual({
			fits: true,
			copies: 4,
		});
		expect(fitWork(tight, needs({ memoryMb: 6_144 }))).toEqual({
			fits: true,
			copies: 1,
		});
		expect(fitWork(tight, needs({ memoryMb: 1_024 }))).toEqual({
			fits: true,
			copies: 4,
		});
		expect(
			fitWork(
				device({
					capacity: { freeSlots: 4, freeMemoryMb: 99_999, freeDiskMb: 5_000 },
				}),
				needs({ memoryMb: 1_024, diskMb: 2_048 }),
			),
		).toEqual({ fits: true, copies: 2 });
	});

	it("says what a device lacks, most basic first", () => {
		const cases: [ObservationInit, NeedsInit, string][] = [
			[{ health: Health.DRAINING }, {}, "slot"],
			[{ health: Health.UNREACHABLE }, {}, "slot"],
			[{ labels: ["other"] }, {}, "label"],
			[{}, { platform: { os: "linux", arch: "arm64" } }, "platform"],
			[{}, { platform: { os: "darwin", arch: "" } }, "platform"],
			[{}, { minSandbox: SandboxTier.S3_MICROVM }, "sandbox"],
			[
				{ sandboxTiers: [] },
				{ minSandbox: SandboxTier.S1_CONTAINER },
				"sandbox",
			],
			[{}, { docker: true }, "docker"],
			[{ capacity: { freeSlots: 0, freeMemoryMb: 99_999 } }, {}, "slot"],
			[
				{ capacity: { freeSlots: 3, freeMemoryMb: 4_000 } },
				{ memoryMb: 6_144 },
				"memory",
			],
			[
				{ capacity: { freeSlots: 3, freeMemoryMb: 99_999, freeDiskMb: 100 } },
				{ memoryMb: 1_024, diskMb: 2_048 },
				"disk",
			],
		];
		for (const [observed, wanted, lacking] of cases)
			expect(fitWork(device(observed), needs(wanted))).toEqual({
				fits: false,
				lacking,
			});
		// No capacity reported at all: no slot to give.
		const silent = device();
		delete silent.capacity;
		expect(fitWork(silent, needs())).toEqual({ fits: false, lacking: "slot" });
	});

	it("treats what is not reported as unknown, not as zero", () => {
		// No memory reported: slots alone decide.
		expect(fitWork(device(), needs({ memoryMb: 6_144 }))).toEqual({
			fits: true,
			copies: 2,
		});
		// No needs stated: any device with a slot and the label.
		expect(
			fitWork(device({ capacity: { freeSlots: 2, freeMemoryMb: 1 } }), needs()),
		).toEqual({ fits: true, copies: 2 });
		// A device that does not say its platform is not ruled out by it.
		const unsaid = device();
		delete unsaid.platform;
		expect(
			fitWork(unsaid, needs({ platform: { os: "linux", arch: "x64" } })),
		).toEqual({ fits: true, copies: 2 });
		// Work that names no label fits whatever the device serves.
		expect(fitWork(device({ labels: [] }), needs({ labels: [] }))).toEqual({
			fits: true,
			copies: 2,
		});
	});

	it("takes a stronger sandbox than the minimum, and Docker only from a micro-VM", () => {
		const microvm = device({
			sandboxTiers: [SandboxTier.S1_CONTAINER, SandboxTier.S3_MICROVM],
		});
		expect(
			fitWork(microvm, needs({ minSandbox: SandboxTier.S2_USER_KERNEL })),
		).toEqual({ fits: true, copies: 2 });
		expect(fitWork(microvm, needs({ docker: true }))).toEqual({
			fits: true,
			copies: 2,
		});
	});
});
