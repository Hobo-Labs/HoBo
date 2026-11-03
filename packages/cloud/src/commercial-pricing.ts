import { createHash } from "node:crypto";
import { catalogHashOf, type PricingCatalog } from "@hobo/pricing";
import type { ResourceDefinition } from "./registry/catalog.js";

// public-contract: capability catalog hashes pin this versioned document shape.
export const CAPABILITY_CATALOG_SCHEMA = "hobo.cloud.capability-catalog/v1";

export function commercialProductRefs(
	definitions: readonly ResourceDefinition[],
): Readonly<Record<string, readonly string[]>> {
	return Object.fromEntries(
		definitions
			.map((definition) => [
				definition.id,
				Object.freeze([
					...new Set(definition.commercialProductRefs ?? []),
				].sort()),
			] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

export function pricingCatalogHash(catalog: PricingCatalog): string {
	return catalogHashOf(catalog);
}

export function capabilityCatalogHash(
	definitions: readonly ResourceDefinition[],
): `sha256:${string}` {
	const summary = definitions
		.map((definition) => ({
			id: definition.id,
			providerId: definition.providerId,
			port: definition.port,
			features: [...definition.features].sort(),
			regions: [...definition.regions].sort(),
			specificity: definition.specificity,
			priority: definition.priority,
			cost: definition.cost,
			commercialProductRefs: [
				...new Set(definition.commercialProductRefs ?? []),
			].sort(),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	const digest = createHash("sha256")
		.update(JSON.stringify({ schema: CAPABILITY_CATALOG_SCHEMA, definitions: summary }))
		.digest("hex");
	return `sha256:${digest}`;
}
