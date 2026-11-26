import {
	DEFAULT_FLEET_ROUTING_MARKS,
	type FleetAllowance,
	type FleetOffer,
	type FleetRoutingMarks,
	parseFleetFinancialModel,
	parseFleetOffer,
	parseFleetRoutingMarks,
} from "@hobo/backend-routing";
import { z } from "zod";
import { RELAY_CACHE_OFFER_DEFAULTS } from "./_generated-assets/relay-offers.js";
import {
	CACHE_BACKEND_IDS,
	type CacheBackendId,
	CacheBindingError,
	DEFAULT_MONTHLY_CACHE_COMMANDS,
} from "./cache-backend.js";

/** A default offer from the catalog; Upstash's command allowance may be overridden. */
function catalogOffer(
	entry: (typeof RELAY_CACHE_OFFER_DEFAULTS)[number],
	commands: number,
): FleetOffer {
	return parseFleetOffer({
		tier: entry.tier,
		capMicros: undefined,
		model: parseFleetFinancialModel({
			backend: entry.backend,
			plan: entry.plan,
			fixedMonthlyFeeMicros: 0,
			allowances: entry.allowances.map(
				(allowance): FleetAllowance => ({
					unit: allowance.unit,
					included:
						entry.backend === "upstash" && allowance.unit === "commands"
							? commands
							: allowance.included,
					beyond: allowance.beyond,
					meteredMicrosPerUnit:
						"meteredMicrosPerUnit" in allowance
							? allowance.meteredMicrosPerUnit
							: undefined,
				}),
			),
			evidence: entry.evidence,
		}),
	});
}

/**
 * The defaults, per backend, from the offer catalog; `commands` overrides
 * Upstash's allowance. `redis` (`REDIS_URL`) has no offer: nobody has said
 * what it is, so it is never moved to for budget reasons. `memory` is free.
 */
export function defaultCacheOffers(
	commands = DEFAULT_MONTHLY_CACHE_COMMANDS,
): ReadonlyMap<CacheBackendId, FleetOffer> {
	const offers = new Map<CacheBackendId, FleetOffer>(
		RELAY_CACHE_OFFER_DEFAULTS.map((entry) => [
			entry.backend,
			catalogOffer(entry, commands),
		]),
	);
	offers.set(
		"memory",
		parseFleetOffer({
			tier: "free",
			capMicros: undefined,
			model: parseFleetFinancialModel({
				backend: "memory",
				plan: "free",
				fixedMonthlyFeeMicros: 0,
				allowances: [],
				evidence: {
					source: "in-memory engine, no provider",
					observedAt: "2026-11-11",
				},
			}),
		}),
	);
	return offers;
}

/** Each backend's catalog rate card (`<backend>=<rate card id>`), for the start-up log. */
export function cacheOfferRateCards(): readonly string[] {
	return RELAY_CACHE_OFFER_DEFAULTS.map(
		(entry) => `${entry.backend}=${entry.rateCardId}`,
	);
}

const Allowance = z
	.object({
		unit: z.enum([
			"commands",
			"rows-read",
			"rows-written",
			"simple-operations",
			"advanced-operations",
			"operations",
		]),
		included: z.number().int().nonnegative().optional(),
		beyond: z.enum(["hard-stop", "metered", "unknown"]),
		meteredMicrosPerUnit: z.number().nonnegative().optional(),
	})
	.strict();
const Offer = z
	.object({
		backend: z.enum(CACHE_BACKEND_IDS),
		tier: z.enum(["free", "prepaid", "payg"]),
		plan: z.string().regex(/^[a-z0-9][a-z0-9 ._-]{0,63}$/u),
		fixedMonthlyFeeMicros: z.number().int().nonnegative().optional(),
		capMicros: z.number().int().nonnegative().optional(),
		allowances: z.array(Allowance).max(8),
		evidence: z
			.object({
				source: z.string().min(1).max(300),
				observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
			})
			.strict(),
	})
	.strict();
const Marks = z
	.object({
		switchAtPercent: z.number().gt(0).lte(100).optional(),
		switchBackBelowPercent: z.number().gt(0).lt(100).optional(),
		minDwellMinutes: z.number().int().nonnegative().max(44_640).optional(),
		failoverAfterSeconds: z.number().int().nonnegative().max(86_400).optional(),
	})
	.strict();
const Document = z
	.object({
		offers: z.array(Offer).max(CACHE_BACKEND_IDS.length).optional(),
		marks: Marks.optional(),
		membershipEpochs: z.boolean().optional(),
	})
	.strict();

/** The relay's marks, unless configured: switch at 90%, back below 80%. */
export const DEFAULT_CACHE_ROUTING_MARKS: FleetRoutingMarks =
	parseFleetRoutingMarks({
		...DEFAULT_FLEET_ROUTING_MARKS,
		// A tick that finds the active cache down probes it for about this long.
		failoverAfterMs: 10_000,
	});

export type CacheOffers = Readonly<{
	offers: ReadonlyMap<CacheBackendId, FleetOffer>;
	marks: FleetRoutingMarks;
	membershipEpochs: boolean;
}>;

/**
 * The declared offers over the defaults: an offer named in the document
 * replaces the default for its backend entirely; marks are merged field by
 * field. `HOBO_CI_CACHE_MONTHLY_COMMANDS` still sets Upstash's default
 * allowance.
 */
export function parseCacheOffers(
	json: string | undefined,
	commands = DEFAULT_MONTHLY_CACHE_COMMANDS,
): CacheOffers {
	const offers = new Map(defaultCacheOffers(commands));
	if (json === undefined || json === "")
		return {
			offers,
			marks: DEFAULT_CACHE_ROUTING_MARKS,
			membershipEpochs: false,
		};
	let document: z.infer<typeof Document>;
	try {
		document = Document.parse(JSON.parse(json));
	} catch {
		throw new CacheBindingError("HOBO_CI_CACHE_OFFERS_JSON is not valid");
	}
	try {
		const seen = new Set<string>();
		for (const entry of document.offers ?? []) {
			if (seen.has(entry.backend)) throw new Error("repeated backend");
			seen.add(entry.backend);
			offers.set(
				entry.backend,
				parseFleetOffer({
					tier: entry.tier,
					capMicros: entry.capMicros,
					model: parseFleetFinancialModel({
						backend: entry.backend,
						plan: entry.plan,
						fixedMonthlyFeeMicros: entry.fixedMonthlyFeeMicros,
						allowances: entry.allowances.map((item) => ({
							unit: item.unit,
							included: item.included,
							beyond: item.beyond,
							meteredMicrosPerUnit: item.meteredMicrosPerUnit,
						})),
						evidence: entry.evidence,
					}),
				}),
			);
		}
		const marks = document.marks ?? {};
		return {
			offers,
			membershipEpochs: document.membershipEpochs ?? false,
			marks: parseFleetRoutingMarks({
				switchAt:
					marks.switchAtPercent === undefined
						? DEFAULT_CACHE_ROUTING_MARKS.switchAt
						: marks.switchAtPercent / 100,
				switchBackBelow:
					marks.switchBackBelowPercent === undefined
						? DEFAULT_CACHE_ROUTING_MARKS.switchBackBelow
						: marks.switchBackBelowPercent / 100,
				minDwellMs:
					marks.minDwellMinutes === undefined
						? DEFAULT_CACHE_ROUTING_MARKS.minDwellMs
						: marks.minDwellMinutes * 60_000,
				failoverAfterMs:
					marks.failoverAfterSeconds === undefined
						? DEFAULT_CACHE_ROUTING_MARKS.failoverAfterMs
						: marks.failoverAfterSeconds * 1000,
			}),
		};
	} catch {
		// The fleet parsers' messages name fields; still, report the key only.
		throw new CacheBindingError("HOBO_CI_CACHE_OFFERS_JSON is not valid");
	}
}
