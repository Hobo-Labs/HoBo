/* oxlint-disable anti-slop/no-runtime-typeof, unicorn/no-useless-fallback-in-spread -- SAFETY: standardCamps preserves its public string input validation and optional label omission contract. */
import { CAMP_TIERS, type CampTier, DEFAULT_CAMP_TIERS } from "@hobo/core";

import { camp } from "./camp.js";
import type { Camp } from "./types.js";

const TIER_PURPOSE: Readonly<Record<CampTier, string>> = Object.freeze({
	[CAMP_TIERS.edge]: "internet-facing ingress",
	[CAMP_TIERS.app]: "business logic, no inbound internet path",
	[CAMP_TIERS.data]: "persistence and state services",
	[CAMP_TIERS.untrusted]: "risky-input and unattested-code workloads",
	[CAMP_TIERS.ops]: "operational surfaces, off the workload path",
});

export interface StandardCampsOptions {
	readonly tiers?: readonly CampTier[];
	readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Builds the standard Camps for one environment.
 *
 * Camp ids are `<envType>-<tier>` — `production-edge`, `production-app`,
 * `production-data`. The environment leads because that is the axis a human
 * scans for first when reading a Yard, and because it keeps every Camp of one
 * environment adjacent when ids are sorted.
 *
 * @example
 * yard(azure, "prod-eu", (y) => {
 *   y.region("westeurope");
 *   for (const c of standardCamps("production")) y.camp(c);
 * });
 */
export function standardCamps(
	envType: string,
	options: StandardCampsOptions = {},
): readonly Camp[] {
	if (typeof envType !== "string" || envType.length === 0) {
		throw new TypeError(
			"standardCamps requires an environment type — tier and environment are separate axes and neither is guessed",
		);
	}

	const tiers = options.tiers ?? DEFAULT_CAMP_TIERS;
	if (tiers.length === 0) {
		throw Object.assign(new Error("standardCamps was asked for no tiers"), {
			code: "CAMP_TIERS_EMPTY",
			remediation:
				"Omit `tiers` for the default three, or name at least one from CAMP_TIERS.",
		});
	}

	const seen = new Set<CampTier>();
	for (const tier of tiers) {
		if (seen.has(tier)) {
			throw Object.assign(
				new Error(`standardCamps received tier ${tier} twice`),
				{
					code: "CAMP_TIER_DUPLICATE",
					remediation: "Name each tier once; a tier is a segment, not a count.",
				},
			);
		}
		seen.add(tier);
	}

	const ordered = DEFAULT_CAMP_TIERS.concat(
		[CAMP_TIERS.untrusted, CAMP_TIERS.ops].filter(
			(tier) => !DEFAULT_CAMP_TIERS.includes(tier),
		),
	).filter((tier) => seen.has(tier));

	return Object.freeze(
		ordered.map((tier) =>
			camp(`${envType}-${tier}`, {
				envType,
				tier,
				labels: {
					...(options.labels ?? {}),
					"hobo.tier": tier,
					"hobo.tier.purpose": TIER_PURPOSE[tier],
				},
			}),
		),
	);
}
