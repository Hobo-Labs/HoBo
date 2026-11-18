import { AWS_RESOLVED_PRODUCT_IDS } from "@hobo/provider-aws";
import { AZURE_RESOLVED_PRODUCT_IDS } from "@hobo/provider-azure";
import { CLOUDFLARE_RESOLVED_PRODUCT_IDS } from "@hobo/provider-cloudflare";
import { DIGITALOCEAN_RESOLVED_PRODUCT_IDS } from "@hobo/provider-digitalocean";
import { GCP_RESOLVED_PRODUCT_IDS } from "@hobo/provider-gcp";
import { HETZNER_RESOLVED_PRODUCT_IDS } from "@hobo/provider-hetzner";
import { HOSTINGER_RESOLVED_PRODUCT_IDS } from "@hobo/provider-hostinger";
import { KUBERNETES_RESOLVED_PRODUCT_IDS } from "@hobo/provider-kubernetes";
import { VERCEL_RESOLVED_PRODUCT_IDS } from "@hobo/provider-vercel";
import type { Yard as ParsedYard } from "@hobo/yards";

import * as aws from "./aws.js";
import * as azure from "./azure.js";
import * as cloudflare from "./cloudflare.js";
import * as digitalocean from "./digitalocean.js";
import * as gcp from "./gcp.js";
import * as hetzner from "./hetzner.js";
import * as hostinger from "./hostinger.js";
import * as kubernetes from "./kubernetes.js";
import * as vercel from "./vercel.js";

export const PARITY_LEVELS = Object.freeze([
	"P0",
	"L1",
	"L2",
	"L3",
	"P2",
	"P3",
] as const);

export type ParityLevel = (typeof PARITY_LEVELS)[number];

export type SimulatedParityLevel = "P0" | "L1-DECLARED";

export type ParityErrorCode =
	| "PARITY_PROVIDER_EMPTY"
	| "PARITY_PRODUCT_ID_EMPTY"
	| "PARITY_CATALOG_EMPTY"
	| "PARITY_RESOLVED_NOT_IN_CATALOG";

export class ParityError extends Error {
	readonly code: ParityErrorCode;

	constructor(code: ParityErrorCode, message: string) {
		super(message);
		this.name = "ParityError";
		this.code = code;
	}
}

export interface ProviderParityRow {
	readonly provider: string;
	readonly catalogProductIds: readonly string[];
	readonly resolvedProductIds: readonly string[];
	readonly level: SimulatedParityLevel;
	readonly denominator: string;
}

export interface ProviderProfileParityRow extends ProviderParityRow {
	readonly profile: string;
}

function canonicalIds(ids: Iterable<string>): readonly string[] {
	const canonical = [...ids];
	for (const id of canonical) {
		if (id.trim() === "") {
			throw new ParityError(
				"PARITY_PRODUCT_ID_EMPTY",
				"A parity row must not contain a blank product id.",
			);
		}
	}
	return Object.freeze([...new Set(canonical)].sort());
}

export function parityRow(
	provider: string,
	catalogProductIds: Iterable<string>,
	resolvedProductIds: Iterable<string>,
): ProviderParityRow {
	if (provider.trim() === "") {
		throw new ParityError(
			"PARITY_PROVIDER_EMPTY",
			"A parity row must name its provider.",
		);
	}
	const catalog = canonicalIds(catalogProductIds);
	const resolved = canonicalIds(resolvedProductIds);
	if (catalog.length === 0) {
		throw new ParityError(
			"PARITY_CATALOG_EMPTY",
			`${provider}: a parity row must contain at least one catalog product id.`,
		);
	}
	const declared = new Set(catalog);
	const stray = resolved.filter((id) => !declared.has(id));
	if (stray.length > 0) {
		throw new ParityError(
			"PARITY_RESOLVED_NOT_IN_CATALOG",
			`${provider}: resolved product ids not in its catalog: ${stray.join(", ")}. ` +
				"A resolver for an offering the Yard cannot declare is unreachable; " +
				"declare the offering or drop the resolver.",
		);
	}
	return Object.freeze({
		provider,
		catalogProductIds: catalog,
		resolvedProductIds: resolved,
		level: resolved.length > 0 ? "L1-DECLARED" : "P0",
		denominator: `${resolved.length}/${catalog.length}`,
	});
}

export const PARITY_PROVIDERS = Object.freeze([
	"aws",
	"azure",
	"cloudflare",
	"digitalocean",
	"gcp",
	"hetzner",
	"hostinger",
	"kubernetes",
	"vercel",
] as const);

export type ParityProvider = (typeof PARITY_PROVIDERS)[number];

export interface ParitySource {
	readonly catalog: () => ParsedYard;
	readonly resolved: readonly string[];
}

export const PARITY_SOURCES: Readonly<Record<ParityProvider, ParitySource>> =
	Object.freeze({
		aws: { catalog: () => aws.Yard(), resolved: AWS_RESOLVED_PRODUCT_IDS },
		azure: {
			catalog: () => azure.Yard(),
			resolved: AZURE_RESOLVED_PRODUCT_IDS,
		},
		cloudflare: {
			catalog: () => cloudflare.Yard(),
			resolved: CLOUDFLARE_RESOLVED_PRODUCT_IDS,
		},
		digitalocean: {
			catalog: () => digitalocean.Yard(),
			resolved: DIGITALOCEAN_RESOLVED_PRODUCT_IDS,
		},
		gcp: { catalog: () => gcp.Yard(), resolved: GCP_RESOLVED_PRODUCT_IDS },
		hetzner: {
			catalog: () => hetzner.Yard(),
			resolved: HETZNER_RESOLVED_PRODUCT_IDS,
		},
		hostinger: {
			catalog: () => hostinger.Yard(),
			resolved: HOSTINGER_RESOLVED_PRODUCT_IDS,
		},
		kubernetes: {
			catalog: () => kubernetes.Yard(),
			resolved: KUBERNETES_RESOLVED_PRODUCT_IDS,
		},
		vercel: {
			catalog: () => vercel.Yard({ project: {} }),
			resolved: VERCEL_RESOLVED_PRODUCT_IDS,
		},
	});

function productIdsOf(yard: ParsedYard): string[] {
	const ids: string[] = [];
	for (const binding of yard.bindings) {
		if (binding.productId !== undefined) ids.push(binding.productId);
	}
	return ids;
}

function productIdsByProfile(yard: ParsedYard): ReadonlyMap<string, string[]> {
	const profiles = new Map<string, string[]>();
	for (const binding of yard.bindings) {
		if (binding.productId === undefined) continue;
		const ids = profiles.get(binding.profile) ?? [];
		ids.push(binding.productId);
		profiles.set(binding.profile, ids);
	}
	return profiles;
}

export function providerParity(): readonly ProviderParityRow[] {
	return Object.freeze(
		PARITY_PROVIDERS.map((provider) => {
			const source = PARITY_SOURCES[provider];
			return parityRow(
				provider,
				productIdsOf(source.catalog()),
				source.resolved,
			);
		}),
	);
}

export function providerProfileParity(): readonly ProviderProfileParityRow[] {
	const rows = PARITY_PROVIDERS.flatMap((provider) => {
		const source = PARITY_SOURCES[provider];
		const profiles = productIdsByProfile(source.catalog());
		return [...profiles.keys()].sort().map((profile) => {
			const catalog = profiles.get(profile) ?? [];
			const declared = new Set(catalog);
			const resolved = source.resolved.filter((id) => declared.has(id));
			return Object.freeze({
				...parityRow(provider, catalog, resolved),
				profile,
			});
		});
	});
	return Object.freeze(rows);
}

const LEVEL_EVIDENCE: Readonly<Record<SimulatedParityLevel, string>> =
	Object.freeze({
		P0: "catalog only",
		"L1-DECLARED": "resolvers declared (conformance not asserted here)",
	});

export function formatParityClaim(row: ProviderParityRow): string {
	const derived = parityRow(
		row.provider,
		row.catalogProductIds,
		row.resolvedProductIds,
	);
	return `${derived.provider} ${derived.level}: ${derived.denominator} ${LEVEL_EVIDENCE[derived.level]}`;
}
