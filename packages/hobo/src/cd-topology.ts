/**
 * Declared Camp topology for @hobo/cd (WP18, plan 0024, D19/D20/D22).
 *
 * `TopologyReader` is composed from `@hobo/yards` Yards and their
 * `@hobo/camps` Camps: the Yard's provider and declared regions, the Camp's
 * env type and labels. Residency is evaluated only against these declared
 * regions; observed claims never enter here (I19). A Camp id is Yard-scoped
 * (`<yard>/<camp>`), as placement records it.
 *
 * Several readers (Yards, an imported ClusterProfile inventory) merge into
 * one; a Camp id declared twice is a configuration error, never a silent
 * override.
 */

import {
	type CampId,
	CampManagement,
	type CampTopology,
	type TopologyReader,
} from "@hobo/cd";
import type { Yard } from "@hobo/yards";

// public-contract: the Camp label that declares a Camp OBSERVE_ONLY (D5).
export const CD_MANAGEMENT_LABEL = "hobo.cd/management";

export function campIdOf(yardName: string, campId: string): CampId {
	// SAFETY: the Yard-scoped id placement and the journal use for a Camp.
	return `${yardName}/${campId}` as CampId;
}

/** Project Yards (and their Camps) as declared CD topology. */
export function yardTopology(
	yards: readonly Yard[],
	stationId: string,
): readonly CampTopology[] {
	const out: CampTopology[] = [];
	for (const yard of yards) {
		for (const camp of yard.camps) {
			const labels = { ...yard.labels, ...camp.labels };
			out.push(
				Object.freeze({
					campId: campIdOf(yard.name, camp.id),
					yardId: yard.name,
					stationId,
					provider: yard.providerId,
					regions: [...yard.regions],
					envType: camp.envType,
					labels,
					management:
						labels[CD_MANAGEMENT_LABEL] === "observe-only"
							? CampManagement.OBSERVE_ONLY
							: CampManagement.MANAGED,
				}),
			);
		}
	}
	return out.sort((a, b) =>
		a.campId < b.campId ? -1 : a.campId > b.campId ? 1 : 0,
	);
}

export class TopologyConflictError extends Error {
	readonly code = "cd-topology-duplicate-camp";
	readonly remediation =
		"Each Camp id may be declared by exactly one source; rename the Camp or drop it from one Yard/ClusterProfile import.";
	constructor(readonly campId: string) {
		super(
			`cd-topology-duplicate-camp: ${campId} is declared by more than one topology source`,
		);
	}
}

/** A static reader over declared Camps. */
export function staticTopologyReader(
	camps: readonly CampTopology[],
): TopologyReader {
	const byId = new Map<string, CampTopology>();
	for (const camp of camps) {
		if (byId.has(camp.campId)) throw new TopologyConflictError(camp.campId);
		byId.set(camp.campId, camp);
	}
	const all = Object.freeze([...byId.values()]);
	return Object.freeze({
		camps: async () => all,
		camp: async (campId: CampId) => byId.get(campId),
	});
}

/** Merge readers; a Camp declared by two readers refuses (fail closed). */
export function mergeTopologyReaders(
	readers: readonly TopologyReader[],
): TopologyReader {
	async function all(): Promise<readonly CampTopology[]> {
		const seen = new Map<string, CampTopology>();
		for (const reader of readers) {
			for (const camp of await reader.camps()) {
				if (seen.has(camp.campId)) throw new TopologyConflictError(camp.campId);
				seen.set(camp.campId, camp);
			}
		}
		return [...seen.values()].sort((a, b) =>
			a.campId < b.campId ? -1 : a.campId > b.campId ? 1 : 0,
		);
	}
	return Object.freeze({
		camps: all,
		async camp(campId: CampId) {
			return (await all()).find((c) => c.campId === campId);
		},
	});
}
