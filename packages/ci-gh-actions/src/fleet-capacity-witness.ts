/**
 * What the box worker knows of its fleet when it decides whether to release
 * trunk custody or an unlaunched reservation: its own free hobo slots and the
 * fleet's free slots, read from `FleetCapacity` (the fleet verdict and view,
 * design §8.1). Slots the fleet has beyond this box's own are peers that can
 * absorb the job. It replaces the mesh/ARC witness of the old relay mesh.
 */
import type { FleetCapacity } from "@hobo/fleet";

export type FleetCapacityWitness = Readonly<{
	/** This box's own free hobo slots. */
	hoboFreeSlots?: number;
	/** Free slots across the fleet (`FleetCapacity.free_slots`), this box included. */
	fleetFreeSlots?: number;
}>;

export type FleetWitnessFields = Readonly<{
	hoboFreeSlots?: number;
	fleetFreeSlots: number;
	peerAbsorbSlots: number;
}>;

/** The witness of this box's free slots against its fleet's capacity; no capacity known means no peers. */
export function fleetCapacityWitness(
	hoboFreeSlots: number,
	capacity: Pick<FleetCapacity, "freeSlots"> | undefined,
): FleetCapacityWitness {
	return capacity === undefined
		? { hoboFreeSlots }
		: { hoboFreeSlots, fleetFreeSlots: capacity.freeSlots };
}

export function fleetWitnessFields(
	witness: FleetCapacityWitness | undefined,
): FleetWitnessFields {
	const hoboFreeSlots = witness?.hoboFreeSlots;
	const own = hoboFreeSlots ?? 0;
	const fleetFreeSlots = witness?.fleetFreeSlots ?? own;
	const peerAbsorbSlots = Math.max(0, fleetFreeSlots - own);
	return hoboFreeSlots === undefined
		? { fleetFreeSlots, peerAbsorbSlots }
		: { hoboFreeSlots, fleetFreeSlots, peerAbsorbSlots };
}

/** Slots other fleet members have free to absorb released custody. */
export function fleetPeerAbsorbSlots(
	witness: FleetCapacityWitness | undefined,
): number {
	return fleetWitnessFields(witness).peerAbsorbSlots;
}

export function fleetCanAbsorbUnlaunchedRelease(
	witness: FleetCapacityWitness | undefined,
): boolean {
	return fleetPeerAbsorbSlots(witness) > 0;
}
