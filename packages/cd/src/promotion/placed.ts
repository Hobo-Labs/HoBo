// Camps a placement-based pipeline node governs (D21, I16). A node names
// either `camp_ids` or a `placement`; for the latter, the governed Camps are
// the ones its recorded `placement.Decided` selected. Lineage reads them here
// and fails closed when the decision cannot be resolved.
import type { PlacementDecisionRecord } from "../_generated/cd_pb.js";
import type { FanoutController, FanoutId, PlacementEngine } from "../ports.js";

/** Governed Camp ids of a placed node, or `undefined` when no recorded decision resolves. */
export type PlacedCamps = (
	input: Readonly<{ pipeline: string; node: string; fanoutId?: FanoutId }>,
) => Promise<readonly string[] | undefined>;

/** Camps a recorded decision selected: every group's Camps plus selected candidates. */
export function campsOfDecision(
	decision: PlacementDecisionRecord,
): readonly string[] {
	const camps = new Set<string>();
	for (const group of decision.groups)
		for (const campId of group.campIds) camps.add(campId);
	for (const candidate of decision.candidates)
		if (candidate.selected) camps.add(candidate.campId);
	return [...camps].sort();
}

/**
 * Reads the recorded decision: the fan-out's own decision when the request
 * carries a fanoutId, else the node's latest completed decision.
 */
export function placedCampsFrom(
	d: Readonly<{
		fanout: Pick<FanoutController, "get" | "qualified">;
		placement: Pick<PlacementEngine, "decision">;
	}>,
): PlacedCamps {
	return async ({ pipeline, node, fanoutId }) => {
		let decision: PlacementDecisionRecord | undefined;
		if (fanoutId !== undefined && fanoutId !== "") {
			const status = await d.fanout.get(fanoutId);
			if (!status || status.decisionId === "") return undefined;
			decision = await d.placement.decision(status.decisionId);
		} else {
			decision = (await d.fanout.qualified({ pipeline, node })).decision;
		}
		if (!decision || decision.pipeline !== pipeline || decision.node !== node)
			return undefined;
		return campsOfDecision(decision);
	};
}
