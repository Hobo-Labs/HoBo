import type {
	JunctionDefinition,
	JunctionFederationPlan,
	PolicyPackDistribution,
	RegistryBundleDistribution,
	TrustAnchorExchange,
} from "./types.js";

export function deriveFederationPlan(
	definition: JunctionDefinition,
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
				anchorRef: `trust-anchor://${fromYard}/${definition.name}`,
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
