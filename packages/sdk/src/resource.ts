import type { CapabilityVerdict, ResourceDefinition } from "@hobo/cloud";

import {
	deepFreeze,
	requireNonEmptyString,
	requireRecord,
	SdkDeclarationError,
} from "./errors.js";
import { RESOURCE_DEFINITION_SCHEMA } from "./schema.js";

// `defineResource` is an authoring factory over @hobo/cloud's EXISTING
// `ResourceDefinition` (packages/cloud/src/registry/catalog.ts) — the exact
// record the Registry projection catalogs and Matching ranks. The SDK adds the
// walkthrough's authoring surface (type/engine/class/with/match) and lowers it
// onto that target type; it invents no second definition shape.

export interface ResourceRealization {
	/** Owning provider id ("azure"); inferred from definitionId when omitted. */
	providerId?: string;
	/** Concrete definition id ("azure.flexiblePostgres"). */
	definitionId?: string;
	regions?: string[];
	cost?: { sku: string; unit: string; marginalPrice: string };
	/** Provider-specific realization properties (ha: true, consistency: …). */
	properties?: Record<string, unknown>;
}

export interface DefineResourceSpec {
	/** Abstract capability port ("database", "kv", "bucket"). */
	type: string;
	engine?: string;
	class?: string;
	/** The provider realization this definition pins — a provider package value. */
	with: ResourceRealization;
	/** Specificity selectors; a definition wins over `{}` defaults by match keys. */
	match?: Record<string, string>;
	features?: string[];
	regions?: string[];
	priority?: number;
}

export interface SdkResourceDefinition extends ResourceDefinition {
	readonly schema: string;
	readonly match: Readonly<Record<string, string>>;
	readonly properties: Readonly<Record<string, unknown>>;
}

function providerIdOf(realization: ResourceRealization): string {
	if (
		typeof realization.providerId === "string" &&
		realization.providerId !== ""
	) {
		return realization.providerId;
	}
	const definitionId = realization.definitionId;
	if (typeof definitionId === "string" && definitionId.includes(".")) {
		const prefix = definitionId.split(".")[0];
		if (prefix !== undefined && prefix !== "") return prefix;
	}
	throw new SdkDeclarationError(
		"defineResource",
		"with.providerId",
		"provider realization must carry providerId or a dotted definitionId",
	);
}

export function defineResource(
	spec: DefineResourceSpec,
): SdkResourceDefinition {
	const record = requireRecord("defineResource", "spec", spec);
	const port = requireNonEmptyString("defineResource", "type", record.type);
	const realization = requireRecord(
		"defineResource",
		"with",
		record.with,
	) as ResourceRealization;
	const providerId = providerIdOf(realization);

	const match = requireRecord("defineResource", "match", record.match ?? {});
	for (const [key, value] of Object.entries(match)) {
		requireNonEmptyString("defineResource", `match.${key}`, value);
	}

	const features = [
		...(spec.engine !== undefined
			? [requireNonEmptyString("defineResource", "engine", spec.engine)]
			: []),
		...(spec.class !== undefined
			? [requireNonEmptyString("defineResource", "class", spec.class)]
			: []),
		...(spec.features ?? []).map((feature, index) =>
			requireNonEmptyString("defineResource", `features[${index}]`, feature),
		),
	];
	const regions = (spec.regions ?? realization.regions ?? []).map(
		(region, index) =>
			requireNonEmptyString("defineResource", `regions[${index}]`, region),
	);
	const id =
		realization.definitionId ??
		[providerId, port, ...(spec.class !== undefined ? [spec.class] : [])].join(
			".",
		);
	// An authored definition outscores the provider's `{}` default by carrying
	// every match selector and feature as specificity.
	const specificity = Object.keys(match).length + features.length;
	const cost = realization.cost ?? {
		sku: id,
		unit: "month",
		marginalPrice: "0",
	};
	const featureSet = new Set(features);

	return deepFreeze({
		schema: RESOURCE_DEFINITION_SCHEMA,
		id,
		providerId,
		port,
		features,
		regions,
		specificity,
		priority: spec.priority ?? 0,
		cost,
		match: { ...(match as Record<string, string>) },
		properties: { ...(realization.properties ?? {}) },
		satisfies(req: { port: string; features?: string[] }): CapabilityVerdict {
			if (req.port !== port) return { kind: "none" };
			const missing = (req.features ?? []).filter(
				(feature) => !featureSet.has(feature),
			);
			return missing.length === 0
				? { kind: "full" }
				: { kind: "partial", missing };
		},
	});
}
