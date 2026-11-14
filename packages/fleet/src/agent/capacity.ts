/**
 * What the agent publishes about its own capacity beyond `deps.capacity` (L43,
 * amendments 4 and 6, D60): the refusal and health of its self-observation.
 *
 * - The agent subtracts its executor's own work (`inUse()`: claims held for
 *   an order plus orders running) from the source's free slots.
 * - The executor fits work against `deps.capacity`; the agent hands it a
 *   source whose health is `PRESSURED` while the host refuses for storage or
 *   pressure, so it claims nothing the observation says it refuses.
 */
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

/** The source the executor reads: the host's refusal for storage or pressure shows as `PRESSURED`. */
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

/** The capacity, health and refusal of the agent's self-observation. */
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
