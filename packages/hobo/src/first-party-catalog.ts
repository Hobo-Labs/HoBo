/**
 * The first-party product catalog, composed from the provider packages.
 *
 * Matching cannot select a product nobody registered. Each provider package
 * owns the facts about its own product — profiles, runtimes, claim story,
 * evidence refs — and this module is the one place those declarations are
 * gathered into the catalog the CLI, the offer compiler and the capability
 * matrix all read. It contains no product facts of its own: every entry here
 * is a re-export of a declaration that lives beside the driver that honours it.
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 *  - A provider that has not declared a `ResourceDefinitionSemantics` block
 *    contributes nothing. It is listed in {@link CATALOG_GAPS} rather than
 *    quietly omitted, so "we have no Neon coverage yet" reads differently from
 *    "Neon is broken".
 *  - Nothing here decides whether a product is *usable*. Trust evidence,
 *    freshness and conformance are evaluated downstream at a supplied instant;
 *    registration only makes a product visible to that judgement.
 */
import type { SelectionCandidate } from "@hobo/capability-profiles";
import type {
	CapabilityVerdict,
	ResourceDefinitionSemantics,
	ResourceDefinitionVNext,
} from "@hobo/cloud";
import { LOCAL_DEFINITIONS } from "@hobo/provider-local";
import {
	NETLIFY_DEFINITIONS,
	semanticsToSelectionCandidate,
} from "@hobo/provider-netlify";
import { PRISMA_RESOURCE_DEFINITION } from "@hobo/provider-prisma-postgres";
import { TTL_SH_RESOURCE_DEFINITION } from "@hobo/provider-ttl-sh";
import { UPSTASH_RESOURCE_DEFINITION } from "@hobo/provider-upstash";
import { VERCEL_SPONSORED_DEFINITIONS } from "@hobo/provider-vercel";

/**
 * A product whose driver has landed but whose catalog declaration has not.
 *
 * Recorded rather than dropped: an empty matrix cell should be traceable to a
 * named piece of missing work, not to a silent omission in an import list.
 */
export type CatalogGap = {
	readonly providerId: string;
	readonly detail: string;
};

export const CATALOG_GAPS: readonly CatalogGap[] = Object.freeze([
	{
		providerId: "neon",
		detail:
			"exports NEON_CLAIMABLE_POSTGRES_CANDIDATE but no ResourceDefinitionSemantics block, so it carries no trustEvidenceRef and cannot be evidence-gated",
	},
	{
		providerId: "cloudflare",
		detail:
			"CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS are SelectionCandidates only; the semantics block naming bootstrap/claim strategy and evidence refs is not declared yet",
	},
]);

/**
 * The legacy half of a definition, as the provider packages declare it.
 *
 * Structural rather than nominal: `@hobo/cloud`'s `ResourceDefinition` uses
 * mutable arrays and each provider declares readonly ones, and neither side
 * should have to weaken its own types for the other's benefit.
 */
type ProviderDeclaredDefinition = {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly features: readonly string[];
	readonly regions: readonly string[];
	readonly specificity: number;
	readonly priority: number;
	readonly cost: {
		readonly sku: string;
		readonly unit: string;
		readonly marginalPrice: string;
	};
	satisfies(req: { port: string; features?: string[] }): {
		readonly kind: "full" | "partial" | "none";
		readonly missing?: readonly string[];
	};
	readonly semantics: ResourceDefinitionSemantics;
};

/** A semantics-only declaration, with no legacy port/feature half. */
type ProviderDeclaredSemantics = {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly semantics: ResourceDefinitionSemantics;
};

/**
 * Adapt a provider's declaration to the catalog's `ResourceDefinition`.
 *
 * Where the provider declared a legacy half we use it verbatim. Where it
 * declared semantics only, the legacy half is derived from the semantics —
 * never invented. In particular `features` comes from the boolean structured
 * capabilities the product actually claims, so `satisfies` answers the legacy
 * port/feature path with the same facts profile matching would use, and the
 * two paths cannot disagree about the same product.
 */
function toResourceDefinition(
	declared: ProviderDeclaredDefinition | ProviderDeclaredSemantics,
): ResourceDefinitionVNext {
	const legacy = "features" in declared ? declared : undefined;
	const features =
		legacy?.features ??
		Object.entries(declared.semantics.structuredCapabilities)
			.filter(([, value]) => value === true)
			.map(([key]) => key)
			.sort();
	const satisfies = (req: {
		port: string;
		features?: string[];
	}): CapabilityVerdict => {
		const verdict =
			legacy !== undefined
				? legacy.satisfies(req)
				: req.port !== declared.port
					? ({ kind: "none" } as const)
					: partialOrFull(
							(req.features ?? []).filter(
								(feature) => !features.includes(feature),
							),
						);
		return verdict.kind === "partial"
			? { kind: "partial", missing: [...(verdict.missing ?? [])] }
			: { kind: verdict.kind };
	};

	return {
		id: declared.id,
		providerId: declared.providerId,
		port: declared.port,
		features: [...features],
		regions: [...(legacy?.regions ?? [])],
		// A semantics-only product is more specific than a generic legacy port
		// entry but should never outrank a product that pinned its own numbers.
		specificity: legacy?.specificity ?? 10,
		priority: legacy?.priority ?? 0,
		cost: legacy?.cost ?? {
			sku: declared.semantics.productId,
			unit: "deployment",
			// Anonymous placements run on the provider's own free allowance or,
			// where HoBo sponsors them, under the declared exposure cap. The cap
			// is the only cost figure this repo is entitled to state: transcribed
			// vendor prices are ranking input, never billing input.
			marginalPrice: String(declared.semantics.sponsorExposureMinorUnits),
		},
		satisfies,
		semantics: declared.semantics,
	};
}

function partialOrFull(missing: readonly string[]): CapabilityVerdict {
	return missing.length === 0
		? { kind: "full" }
		: { kind: "partial", missing: [...missing] };
}

/**
 * Every first-party product with a declared semantics block.
 *
 * Sorted by id so the catalog digest — and therefore every signed resolution
 * receipt that pins it — is independent of import order.
 */
export const FIRST_PARTY_DEFINITIONS: readonly ResourceDefinitionVNext[] =
	Object.freeze(
		[
			toResourceDefinition(UPSTASH_RESOURCE_DEFINITION),
			toResourceDefinition(PRISMA_RESOURCE_DEFINITION),
			toResourceDefinition(TTL_SH_RESOURCE_DEFINITION),
			...NETLIFY_DEFINITIONS.map(toResourceDefinition),
			...VERCEL_SPONSORED_DEFINITIONS.map(toResourceDefinition),
			// The localhost Yard's engine-backed products. Registration makes
			// them visible to composed selection on `yard:local`; their
			// shipped evidence fields fail closed until a station supplies
			// evidence, exactly as for every other entry here.
			...LOCAL_DEFINITIONS.map(toResourceDefinition),
		].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	);

/** The same catalog, projected for profile-aware selection. */
export const FIRST_PARTY_CANDIDATES: readonly SelectionCandidate[] =
	Object.freeze(
		FIRST_PARTY_DEFINITIONS.map((definition) =>
			semanticsToSelectionCandidate({
				id: definition.id,
				providerId: definition.providerId,
				port: definition.port,
				// The projection reads only the semantics block, and both sides
				// took that block from the same provider declaration.
				// SAFETY: assertion required at this I/O or test boundary.
				semantics: definition.semantics as never,
			}),
		),
	);

/** Trust evidence refs the catalog expects to find published. */
export function firstPartyEvidenceRefs(): readonly string[] {
	return Object.freeze(
		[
			...new Set(
				FIRST_PARTY_DEFINITIONS.flatMap((definition) =>
					definition.semantics === undefined
						? []
						: [definition.semantics.trustEvidenceRef],
				),
			),
		].sort(),
	);
}
