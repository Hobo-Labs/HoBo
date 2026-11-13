/**
 * What each cache backend costs and allows, and the marks the relay switches
 * at: declared configuration, with defaults derived from the relay's offer
 * catalog (phase 5): each backend's offer is a provider manifest in
 * `offers/*.provider.yaml`, lowered into an `@hobo/pricing` catalog by
 * `scripts/generate-offers.mts` (`src/_generated-assets/relay-offers.ts`).
 * The figures are the vendor tiers the ADR-0179 amendment records (read
 * 2026-11-11; re-check at provisioning).
 *
 * The record is `RelayCacheOffers` in `data-models/cache_offers.proto`
 * (constrained by `data-models/cache-offers/cache_offers.cue`); it arrives as
 * the JSON value of `HOBO_CI_CACHE_OFFERS_JSON`, from the config service or
 * the environment. Parse, don't validate: `parseCacheOffers` turns it into
 * the derived `FleetOffer`s and `FleetRoutingMarks` of `@hobo/backend-routing`
 * once, and an invalid document is an error naming the key, never quoting it.
 *
 * | Backend | Default | Source |
 * |---|---|---|
 * | `upstash` | free: 500,000 commands a month, then blocked | upstash.com/pricing |
 * | `valkey` | free: no command cap (Aiven for Valkey free, or self-hosted) | aiven.io free-tier docs |
 * | `redis` | none: nobody has said what `REDIS_URL` is, so it is never moved to for budget reasons | — |
 * | `turso` | free: 500 million rows read and 10 million written a month, then blocked | turso.tech/pricing |
 * | `blob` | pay-as-you-go: $0.40 a million simple and $5 a million advanced operations, cap $0 | vercel.com/pricing (unverified for this store) |
 * | `memory` | free, no cap (tests and local runs) | — |
 *
 * A cap of zero means no money: a pay-as-you-go backend is a candidate only
 * once an owner declares a cap for it.
 */
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
	/** The cache fleet's `membership_epochs` (design §6.10): false until the last cutover step. */
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
