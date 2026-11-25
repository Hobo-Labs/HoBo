import type { CapabilityManifest } from "@hobo/core";
import type { ParsedProviderManifest } from "./parse.js";
import { toCapabilityManifest, toCostDocument } from "./publish.js";

export type ManifestCapability = {
	readonly port: string;
	satisfies(req: { port: string; features?: string[] }): {
		kind: string;
		missing?: string[];
	};
	estimateCost(req: { port: string }): {
		marginalPrice: string;
		sku: string;
		unit: string;
		pricingStatus?: "unknown" | "estimate" | "verified-zero";
	};
};

export type ManifestProvider = {
	readonly id: string;
	readonly regions: string[];
	readonly capabilities: ManifestCapability[];
	readonly shadowedMappings: readonly string[];
	capabilityManifest(): CapabilityManifest;
};

type CostFact = {
	readonly port?: string;
	readonly sku?: string;
	readonly unit?: string;
	readonly marginalPrice?: string;
	readonly pricingStatus?: "unknown" | "estimate";
};

export function providerFromManifest(
	manifest: ParsedProviderManifest,
): ManifestProvider {
	const published = toCapabilityManifest(manifest);
	const facts = toCostDocument(manifest).facts as readonly CostFact[];
	const mappings = manifest.capabilities?.mappings ?? [];
	const capabilities: ManifestCapability[] = [];
	const shadowedMappings: string[] = [];
	const regions = new Set(manifest.capabilities?.regions ?? []);

	for (const mapping of mappings) {
		for (const region of mapping.regions) regions.add(region);
		if (capabilities.some((capability) => capability.port === mapping.port)) {
			shadowedMappings.push(mapping.id);
			continue;
		}
		const fact = facts.find((candidate) => candidate.port === mapping.port);
		capabilities.push({
			port: mapping.port,
			satisfies(req) {
				if (req.port !== mapping.port) return { kind: "none" };
				const missing = (req.features ?? []).filter(
					(feature) => !mapping.features.includes(feature),
				);
				return missing.length === 0
					? { kind: "full" }
					: { kind: "partial", missing };
			},
			estimateCost() {
				return {
					marginalPrice: fact?.marginalPrice ?? "0",
					sku: fact?.sku ?? `${published.providerId}:${mapping.port}`,
					unit: fact?.unit ?? "",
					pricingStatus: fact?.pricingStatus ?? "unknown",
				};
			},
		});
	}

	return {
		id: published.providerId,
		regions: [...regions],
		capabilities,
		shadowedMappings,
		capabilityManifest: () => published,
	};
}
