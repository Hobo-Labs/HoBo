import type { FleetCapacity } from "@hobo/fleet";

export type PeerCapacityWitness = Readonly<{
	hoboFreeSlots?: number;
	fleetFreeSlots?: number;
}>;

export type PeerWitnessFields = Readonly<{
	hoboFreeSlots?: number;
	fleetFreeSlots: number;
	peerAbsorbSlots: number;
}>;

export function peerCapacityWitness(
	hoboFreeSlots: number,
	capacity: Pick<FleetCapacity, "freeSlots"> | undefined,
): PeerCapacityWitness {
	return capacity === undefined
		? { hoboFreeSlots }
		: { hoboFreeSlots, fleetFreeSlots: capacity.freeSlots };
}

export function peerWitnessFields(
	witness: PeerCapacityWitness | undefined,
): PeerWitnessFields {
	const hoboFreeSlots = witness?.hoboFreeSlots;
	const own = hoboFreeSlots ?? 0;
	const fleetFreeSlots = witness?.fleetFreeSlots ?? own;
	const peerAbsorbSlots = Math.max(0, fleetFreeSlots - own);
	return hoboFreeSlots === undefined
		? { fleetFreeSlots, peerAbsorbSlots }
		: { hoboFreeSlots, fleetFreeSlots, peerAbsorbSlots };
}

export function peerAbsorbSlotsOf(
	witness: PeerCapacityWitness | undefined,
): number {
	return peerWitnessFields(witness).peerAbsorbSlots;
}

export function peersCanAbsorbUnlaunchedRelease(
	witness: PeerCapacityWitness | undefined,
): boolean {
	return peerAbsorbSlotsOf(witness) > 0;
}
