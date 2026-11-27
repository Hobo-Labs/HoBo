import {
	AutoPromotion,
	type FreightRecord,
	type PipelineNodeRecord,
	type PipelineRecord,
} from "../_generated/cd_pb.js";
import type { NodeAvailability } from "./availability.js";

export type PromotionCandidate = Readonly<{
	freight: FreightRecord;
	availability: NodeAvailability;
}>;

export function autoPromotionFreightId(
	pipeline: PipelineRecord,
	node: PipelineNodeRecord,
	list: readonly PromotionCandidate[],
	currentByNode: ReadonlyMap<string, string>,
	stableFreightId: string | undefined,
): string | undefined {
	if (
		node.autoPromotion === AutoPromotion.DISABLED ||
		node.autoPromotion === AutoPromotion.UNSPECIFIED
	)
		return undefined;
	switch (node.autoPromotion) {
		case AutoPromotion.NEWEST:
			return list[0]?.freight.freightId;
		case AutoPromotion.MATCH_UPSTREAM: {
			const upstream = node.fromNodes[0];
			const current = upstream
				? currentByNode.get(`${pipeline.name}|${upstream}`)
				: undefined;
			const match = list.find(
				(candidate) =>
					candidate.freight.freightId === current &&
					candidate.availability.lineage,
			);
			return match?.freight.freightId;
		}
		case AutoPromotion.MATCH_NODE:
			return stableFreightId;
		default:
			return undefined;
	}
}
