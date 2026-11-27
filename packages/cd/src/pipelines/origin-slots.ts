import {
	AutoPromotion,
	type FreightOriginSlotRecord,
	type PipelineNodeRecord,
} from "../_generated/cd_pb.js";
import type { PromotionCandidate } from "./auto-promotion.js";
import { ORIGIN_SOURCES, PIPELINE_REASON } from "./reasons.js";

const SLOT_SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

type ReasonFn = (
	code: string,
	message: string,
	remediation: string,
	target: string,
) => void;

export function candidatesForSlot(
	list: readonly PromotionCandidate[],
	slot: FreightOriginSlotRecord,
): PromotionCandidate[] {
	const sources = new Set(slot.fromSources);
	return list.filter((candidate) =>
		candidate.availability.via.some((via) => sources.has(via)),
	);
}

export function effectiveSlotNode(
	node: PipelineNodeRecord,
	slot: FreightOriginSlotRecord,
): PipelineNodeRecord {
	if (slot.autoPromotion === AutoPromotion.UNSPECIFIED) return node;
	return { ...node, autoPromotion: slot.autoPromotion };
}

export function validateOriginSlots(
	node: PipelineNodeRecord,
	at: string,
	sources: ReadonlySet<string>,
	add: ReasonFn,
): void {
	const seen = new Set<string>();
	for (const slot of node.originSlots ?? []) {
		const sat = `${at}.originSlots.${slot.name || "?"}`;
		if (slot.name === "")
			add(
				PIPELINE_REASON.invalid,
				`origin slot on node "${node.name}" is missing a name`,
				"Name each origin slot with a unique slug.",
				sat,
			);
		else if (!SLOT_SLUG.test(slot.name))
			add(
				PIPELINE_REASON.invalid,
				`origin slot name "${slot.name}" is not a slug`,
				"Name each origin slot with a unique slug.",
				sat,
			);
		if (seen.has(slot.name))
			add(
				PIPELINE_REASON.invalid,
				`duplicate origin slot "${slot.name}" on node "${node.name}"`,
				"Use a distinct name per slot on the node.",
				sat,
			);
		seen.add(slot.name);
		if (slot.fromSources.length === 0)
			add(
				PIPELINE_REASON.noSource,
				`origin slot "${slot.name}" has no sources`,
				"List at least one Freight source or origin pseudo-source per slot.",
				sat,
			);
		for (const source of slot.fromSources)
			if (!sources.has(source) && !ORIGIN_SOURCES.has(source))
				add(
					PIPELINE_REASON.unknownSource,
					`Freight source "${source}" is not defined`,
					`Define the source first, or use origin pseudo-sources for pushed Freight.`,
					`${sat}.fromSources`,
				);
	}
}

export function pipelineKeyForSlot(baseKey: string, slotName: string): string {
	return `${baseKey}:slot:${slotName}`;
}
