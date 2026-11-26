/**
 * Yard placement / generation command-event family.
 * Every decision is a fact; inventory and generation sagas rebuild via pure folds.
 */

import {
	cloneAsJson,
	isJsonObject,
	type JsonBag,
	type JsonObject,
} from "../json.js";

export const YARD_EVENTS = {
	PlacementRequested: "yard.PlacementRequested",
	MatchDecided: "yard.MatchDecided",
	GenerationRequested: "yard.GenerationRequested",
	GenerationReserved: "yard.GenerationReserved",
	GenerationApprovalRequired: "yard.GenerationApprovalRequired",
	GenerationStarted: "yard.GenerationStarted",
	GenerationProgressed: "yard.GenerationProgressed",
	GenerationProvisioned: "yard.GenerationProvisioned",
	Registered: "yard.Registered",
	AttestationStarted: "yard.AttestationStarted",
	Attested: "yard.Attested",
	Ready: "yard.Ready",
	StatusChanged: "yard.StatusChanged",
	CapacityUpdated: "yard.CapacityUpdated",
	GenerationFailed: "yard.GenerationFailed",
	GenerationCompensationRequested: "yard.GenerationCompensationRequested",
	GenerationCompensated: "yard.GenerationCompensated",
	PlacementResolved: "yard.PlacementResolved",
	PlacementRejected: "yard.PlacementRejected",
	/** Provider-native signal normalized into the yard stream. */
	ProviderSignalNormalized: "yard.ProviderSignalNormalized",
} as const;

export type YardEventType = (typeof YARD_EVENTS)[keyof typeof YARD_EVENTS];

export interface YardEvent {
	readonly type: YardEventType | string;
	readonly data: JsonObject;
	readonly seq?: number;
	readonly occurredAt?: string;
}

export function yardEvent<T>(
	type: YardEventType,
	data: T,
	meta?: { readonly seq?: number; readonly occurredAt?: string },
): YardEvent {
	const json = cloneAsJson(data);
	const record: JsonBag = {};
	Object.assign(record, isJsonObject(json) ? json : { value: json });
	return Object.freeze({
		type,
		data: Object.freeze(record),
		...(meta?.seq !== undefined ? { seq: meta.seq } : undefined),
		...(meta?.occurredAt !== undefined
			? { occurredAt: meta.occurredAt }
			: { occurredAt: new Date().toISOString() }),
	});
}

/** All yard.* types the inventory/generation folds consume. */
export const YARD_EVENT_READ_SET: readonly string[] = Object.freeze(
	Object.values(YARD_EVENTS),
);

export function isYardEventType(type: string): type is YardEventType {
	// SAFETY: assertion required at this I/O or test boundary.
	return (Object.values(YARD_EVENTS) as string[]).includes(type);
}
