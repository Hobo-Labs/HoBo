import { create } from "@bufbuild/protobuf";
import {
	type Capacity,
	CapacitySchema,
	type Health,
	type Refusal,
} from "../_generated/fleet_pb.js";
import {
	type CapacityReading,
	deriveRefusal,
	hostSignalsOf,
	publishedHealth,
} from "../observation/refusal.js";
import type { CapacitySource } from "../ports.js";

export function refusingCapacity(source: CapacitySource): CapacitySource {
	return Object.freeze({
		async read() {
			const reading = await source.read();
			const refusal = deriveRefusal({
				draining: false,
				health: reading.health,
				capacity: reading.capacity,
				host: hostSignalsOf(reading),
			});
			return Object.freeze({
				capacity: reading.capacity,
				health: publishedHealth(refusal, reading.health),
				labels: reading.labels,
			});
		},
	} satisfies CapacitySource);
}

export type SelfCapacity = Readonly<{
	capacity: Capacity | undefined;
	health: Health;
	refusal: Refusal;
}>;

export function selfCapacity(
	reading: CapacityReading | undefined,
	running: number,
	draining: boolean,
): SelfCapacity {
	const capacity =
		reading === undefined
			? undefined
			: create(CapacitySchema, {
					...reading.capacity,
					freeSlots: Math.max(0, reading.capacity.freeSlots - running),
				});
	const refusal = deriveRefusal({
		draining,
		health: reading?.health,
		capacity,
		host: hostSignalsOf(reading),
	});
	return Object.freeze({
		capacity,
		health: publishedHealth(refusal, reading?.health),
		refusal,
	});
}
