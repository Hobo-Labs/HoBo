import type { PlacementDecisionRecord } from "../_generated/cd_pb.js";
import type { FanoutController, FanoutId, PlacementEngine } from "../ports.js";

export type PlacedCamps = (
	input: Readonly<{ pipeline: string; node: string; fanoutId?: FanoutId }>,
) => Promise<readonly string[] | undefined>;

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
