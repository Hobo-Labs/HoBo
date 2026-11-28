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

type ProviderDeclaredSemantics = {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly semantics: ResourceDefinitionSemantics;
};

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
		specificity: legacy?.specificity ?? 10,
		priority: legacy?.priority ?? 0,
		cost: legacy?.cost ?? {
			sku: declared.semantics.productId,
			unit: "deployment",
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

export const FIRST_PARTY_DEFINITIONS: readonly ResourceDefinitionVNext[] =
	Object.freeze(
		[
			toResourceDefinition(UPSTASH_RESOURCE_DEFINITION),
			toResourceDefinition(PRISMA_RESOURCE_DEFINITION),
			toResourceDefinition(TTL_SH_RESOURCE_DEFINITION),
			...NETLIFY_DEFINITIONS.map(toResourceDefinition),
			...VERCEL_SPONSORED_DEFINITIONS.map(toResourceDefinition),
			...LOCAL_DEFINITIONS.map(toResourceDefinition),
		].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	);

export const FIRST_PARTY_CANDIDATES: readonly SelectionCandidate[] =
	Object.freeze(
		FIRST_PARTY_DEFINITIONS.map((definition) =>
			semanticsToSelectionCandidate({
				id: definition.id,
				providerId: definition.providerId,
				port: definition.port,
				// SAFETY: assertion required at this I/O or test boundary.
				semantics: definition.semantics as never,
			}),
		),
	);

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
