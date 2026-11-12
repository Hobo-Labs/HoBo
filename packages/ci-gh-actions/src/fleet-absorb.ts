/** Mesh witness for cooperative trunk release (box daemon + NATS). */
export type FleetCapacityWitness = Readonly<{
	hoboFreeSlots?: number;
	arcFreeSlots?: number;
	meshFreeSlots?: number;
}>;

export type FleetWitnessFields = Readonly<{
	hoboFreeSlots?: number;
	arcFreeSlots: number;
	meshFreeSlots: number;
	peerAbsorbSlots: number;
}>;

export function fleetWitnessFields(
	witness: FleetCapacityWitness | undefined,
): FleetWitnessFields {
	const hoboFreeSlots = witness?.hoboFreeSlots;
	const hoboForMesh = hoboFreeSlots ?? 0;
	const arcFreeSlots = witness?.arcFreeSlots ?? 0;
	const meshFreeSlots = witness?.meshFreeSlots ?? hoboForMesh + arcFreeSlots;
	const peerFromMesh =
		meshFreeSlots > hoboForMesh ? meshFreeSlots - hoboForMesh : 0;
	const peerAbsorbSlots = Math.max(arcFreeSlots, peerFromMesh);
	if (hoboFreeSlots !== undefined) {
		return { hoboFreeSlots, arcFreeSlots, meshFreeSlots, peerAbsorbSlots };
	}
	return { arcFreeSlots, meshFreeSlots, peerAbsorbSlots };
}

/** Peer boxes, ARC, or other mesh-reported overflow can take released custody. */
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
