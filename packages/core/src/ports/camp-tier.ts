import { isJsonString, type JsonValue } from "../json.js";

export const CAMP_TIERS = Object.freeze({
	edge: "edge",

	app: "app",

	data: "data",

	untrusted: "untrusted",

	ops: "ops",
} as const);

export type CampTier = (typeof CAMP_TIERS)[keyof typeof CAMP_TIERS];

export const CAMP_TIER_ORDER: readonly CampTier[] = Object.freeze([
	CAMP_TIERS.edge,
	CAMP_TIERS.app,
	CAMP_TIERS.data,
	CAMP_TIERS.untrusted,
	CAMP_TIERS.ops,
]);

export const DEFAULT_CAMP_TIERS: readonly CampTier[] = Object.freeze([
	CAMP_TIERS.edge,
	CAMP_TIERS.app,
	CAMP_TIERS.data,
]);

export function isCampTier(value: JsonValue | undefined): value is CampTier {
	return (
		isJsonString(value) &&
		(CAMP_TIER_ORDER as readonly string[]).includes(value)
	);
}

export const CAMP_TIER_EGRESS: Readonly<Record<CampTier, readonly CampTier[]>> =
	Object.freeze({
		edge: Object.freeze([CAMP_TIERS.app, CAMP_TIERS.untrusted]),
		untrusted: Object.freeze([]),
		app: Object.freeze([CAMP_TIERS.data, CAMP_TIERS.untrusted]),
		data: Object.freeze([]),
		ops: Object.freeze([
			CAMP_TIERS.edge,
			CAMP_TIERS.app,
			CAMP_TIERS.data,
			CAMP_TIERS.untrusted,
		]),
	});
