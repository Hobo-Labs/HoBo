import type { RoutingTopology } from "./synthesize.js";

/** Provider-supplied observation of a single backend (observe.health / observe.location). */
export type RoutingBackendObservation = Readonly<{
	backendId: string;
	/** true/false when known; omit when the provider cannot observe health. */
	healthy?: boolean;
	/** Location labels, e.g. `region:us-central1`. */
	locationHints?: readonly string[];
	/** Optional free-form notes for operators (never credentials). */
	notes?: readonly string[];
}>;

export type RoutingObservations = Readonly<{
	/** When true, backends not listed are treated as health-unknown (not unhealthy). */
	backends: readonly RoutingBackendObservation[];
	observedAt?: string;
	source?: string;
}>;

/**
 * Merge provider observations into a routing topology for synthesis.
 * Observations never invent backends; unknown backend ids are ignored.
 * Unobserved backends keep prior topology health/location values.
 */
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

/**
 * Synthesize-friendly helper: apply observations then leave topology ready for
 * `synthesizeRoutingPlan`. Separated so adapters can own observation fetch.
 */
export function topologyWithObservations(
	topology: RoutingTopology,
	observations: RoutingObservations | undefined,
): RoutingTopology {
	return applyRoutingObservations(topology, observations);
}
