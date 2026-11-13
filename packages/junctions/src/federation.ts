import type { Outcome, TrustRecord } from "@hobo/fleet";
import { acceptTrust } from "@hobo/fleet/keys";
import type {
	JunctionDefinition,
	JunctionFederationPlan,
	PolicyPackDistribution,
	RegistryBundleDistribution,
	TrustAnchorExchange,
	YardTrustRecords,
} from "./types.js";

/**
 * Derive the federation records that ride the same member mechanism as
 * connectivity: pairwise exchange of each member Yard's fleet trust record,
 * per-member signed policy-pack distribution, and pairwise signed
 * registry-bundle distribution. Records only — realization is each yard's job.
 * A Yard absent from `trust` has not published its trust record yet; its
 * exchanges carry `null`.
 */
export function deriveFederationPlan(
	definition: JunctionDefinition,
	trust: YardTrustRecords = {},
): JunctionFederationPlan {
	const names = definition.members.map((member) => member.yardName);

	const trustExchanges: TrustAnchorExchange[] = [];
	const registryBundles: RegistryBundleDistribution[] = [];
	for (const fromYard of names) {
		for (const toYard of names) {
			if (fromYard === toYard) continue;
			trustExchanges.push({
				kind: "trust-anchor-exchange",
				fromYard,
				toYard,
				trust: Object.hasOwn(trust, fromYard)
					? (trust[fromYard] ?? null)
					: null,
			});
			registryBundles.push({
				kind: "registry-bundle-distribution",
				fromYard,
				toYard,
				bundleRef: `registry-bundle://${fromYard}/${definition.name}`,
				signed: true,
			});
		}
	}

	const policyPacks: PolicyPackDistribution[] = names.map((toYard) => ({
		kind: "policy-pack-distribution",
		toYard,
		packRef: `policy-pack://${definition.name}/default`,
		signed: true,
	}));

	return { trustExchanges, policyPacks, registryBundles };
}

/**
 * The receiving Yard's check of one trust exchange: the exchanged record is
 * accepted under the fleet's trust rule (`acceptTrust`, design §7.4), so on
 * first sight it must carry both signatures over the same record, and after
 * that it must follow the pinned record of that Yard (same tenant, higher
 * sequence, signed by keys of the pinned record).
 */
export function acceptFederatedTrust(
	exchange: TrustAnchorExchange,
	pinned: TrustRecord | undefined,
): Outcome<TrustRecord> {
	if (exchange.trust === null)
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: `${exchange.fromYard} has not published its trust record`,
				detail: { check: "trust" },
			},
		};
	return acceptTrust(pinned, exchange.trust);
}
