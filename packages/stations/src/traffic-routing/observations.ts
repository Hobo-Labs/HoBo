import type { RoutingTopology } from "./synthesize.js";

export type RoutingBackendObservation = Readonly<{
	backendId: string;
	healthy?: boolean;
	locationHints?: readonly string[];
	notes?: readonly string[];
}>;

export type RoutingObservations = Readonly<{
	backends: readonly RoutingBackendObservation[];
	observedAt?: string;
	source?: string;
}>;

export function applyRoutingObservations(
	topology: RoutingTopology,
	observations: RoutingObservations | undefined,
): RoutingTopology {
	if (!observations || observations.backends.length === 0) {
		return topology;
	}
	const byId = new Map(
		observations.backends.map((entry) => [entry.backendId, entry] as const),
	);
	const backends = topology.backends.map((backend) => {
		const observed = byId.get(backend.id);
		if (!observed) return backend;
		return Object.freeze({
			...backend,
			...(observed.healthy !== undefined
				? { healthy: observed.healthy }
				: undefined),
			...(observed.locationHints !== undefined
				? { locationHints: Object.freeze([...observed.locationHints]) }
				: undefined),
		});
	});
	return Object.freeze({
		...topology,
		backends: Object.freeze(backends),
	});
}

export function topologyWithObservations(
	topology: RoutingTopology,
	observations: RoutingObservations | undefined,
): RoutingTopology {
	return applyRoutingObservations(topology, observations);
}
