import { create } from "@bufbuild/protobuf";
import {
	type FleetCapacity,
	FleetCapacitySchema,
	Health,
	type Observation,
} from "../_generated/fleet_pb.js";
import type { FleetLog } from "../ports.js";

function sumOf(values: readonly (number | undefined)[]): number | undefined {
	const known = values.filter((value) => value !== undefined);
	return known.length === 0
		? undefined
		: known.reduce((sum, value) => sum + value, 0);
}

export function fleetCapacity(
	live: readonly Observation[],
	counts: (observation: Observation) => boolean = () => true,
): FleetCapacity {
	const counted = live.filter(counts);
	const healthy = counted.filter(
		(observation) => observation.health === Health.REACHABLE,
	);
	const memory = healthy.map((each) => each.capacity?.freeMemoryMb);
	const known = memory.filter((value) => value !== undefined);
	return create(FleetCapacitySchema, {
		live: counted.length,
		healthy: healthy.length,
		totalSlots: healthy.reduce(
			(sum, each) =>
				sum + (each.capacity?.totalSlots ?? each.capacity?.freeSlots ?? 0),
			0,
		),
		freeSlots: healthy.reduce(
			(sum, each) => sum + (each.capacity?.freeSlots ?? 0),
			0,
		),
		freeMemoryMb: sumOf(memory),
		freeDiskMb: sumOf(healthy.map((each) => each.capacity?.freeDiskMb)),
		maxMemoryMb: known.length === 0 ? undefined : Math.max(...known),
	});
}

function fieldsOf(capacity: FleetCapacity) {
	return {
		live: capacity.live,
		healthy: capacity.healthy,
		totalSlots: capacity.totalSlots,
		freeSlots: capacity.freeSlots,
		freeMemoryMb: capacity.freeMemoryMb ?? -1,
		freeDiskMb: capacity.freeDiskMb ?? -1,
		maxMemoryMb: capacity.maxMemoryMb ?? -1,
	};
}

export type CapacityMonitor = Readonly<{
	observe(capacity: FleetCapacity, nowMs: number): void;
}>;

export function createCapacityMonitor(
	options: Readonly<{ log: FleetLog; summaryEveryMs?: number }>,
): CapacityMonitor {
	const summaryEveryMs = options.summaryEveryMs ?? 60_000;
	let exhausted = false;
	let summarizedAt: number | undefined;
	return {
		observe(capacity, nowMs) {
			let changed = summarizedAt === undefined;
			const full = capacity.live > 0 && capacity.freeSlots === 0;
			if (full !== exhausted) {
				exhausted = full;
				changed = true;
				options.log(
					full
						? "hobo_fleet_capacity_exhausted"
						: "hobo_fleet_capacity_restored",
					fieldsOf(capacity),
				);
			}
			if (
				changed ||
				nowMs - (summarizedAt ?? Number.NEGATIVE_INFINITY) >= summaryEveryMs
			) {
				summarizedAt = nowMs;
				options.log("hobo_fleet_capacity", fieldsOf(capacity));
			}
		},
	};
}
