/**
 * Parity taxonomy: how far each provider namespace is actually proven, read
 * off the code rather than written down beside it.
 *
 * Why this module exists: resolver coverage was stated in prose in four places
 * (this package's index header, `src/aws.ts`, the README, the live-provider
 * matrix), and they disagreed with each other and with the provider packages'
 * own `*_RESOLVED_PRODUCT_IDS` constants. A number nobody recomputes is a claim
 * nobody checks. So the denominator here is *derived*: the catalog side comes
 * from the namespace's parsed `Yard().bindings`, the resolved side from the
 * constant the provider package exports, and nothing in between is typed by
 * hand.
 *
 * The vocabulary is the council's (docs/plans/alchemy-parity/council-decision.md):
 *
 *   - `P0` — catalog only: declarable, no resolver.
 *   - `L1` — simulated: a fake-transport resolver **plus** the six lifecycle
 *     conformance cases (create/update/replace/delete-idempotent/adopt/
 *     crash-resume) **plus** a PACT.
 *   - `L2` — local-live: the six lifecycle cases against real local processes.
 *   - `L3` — local-DX: a timed offline script, minutes recorded.
 *   - `P2` / `P3` — cloud live / cloud DX. Fallback claims only.
 *
 * WHAT THIS LAYER CAN SEE: constants only. It sees that a resolver id is
 * *declared* (`*_RESOLVED_PRODUCT_IDS`); it cannot see a conformance run or a
 * pact. It therefore emits `L1-DECLARED`, explicitly not the council's full L1.
 * `L2`/`L3`/`P2`/`P3` are never emitted: they need executed evidence later
 * layers own, and printing one from static data would be exactly the overclaim
 * this module exists to remove.
 *
 * Grain: per-provider or per-`(provider, profile)` *product* count. Provider
 * rows de-duplicate a product listed under two profiles; profile rows contain
 * only that profile's ids and resolved subset. One resolved product makes the
 * row `L1-DECLARED`; zero makes it `P0`. The denominator, not the level, says
 * how much is covered.
 *
 * This is a read model, not a deployment decision (see ADR.md): it does not
 * select among a Yard's offerings for deployment. It does canonicalize —
 * ids are sorted and de-duplicated, bindings without a `productId` are left
 * out of the product counts, and rows come back in `PARITY_PROVIDERS` order.
 * A resolved id the catalog does not declare is refused with a typed error
 * rather than dropped, because silently dropping it would make the
 * denominator look tidier than the code is.
 *
 * Determinism: no clock, no randomness, no environment reads; ids are
 * de-duplicated and sorted; every returned value is deep-frozen.
 */
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

/** The closed council vocabulary, local levels before cloud fallbacks. */
// public-contract: the parity level vocabulary every parity claim depends on.
export const PARITY_LEVELS = Object.freeze([
	"P0",
	"L1",
	"L2",
	"L3",
	"P2",
	"P3",
] as const);

export type ParityLevel = (typeof PARITY_LEVELS)[number];

/**
 * The only levels this projection may emit. Full L1 additionally requires the
 * six-case conformance suite and PACT evidence that this projection cannot see.
 */
export type SimulatedParityLevel = "P0" | "L1-DECLARED";

// public-contract: refusal codes callers may branch on.
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

/**
 * One provider's derived parity. The id lists show which products resolve;
 * this in-process read model has no wire representation.
 */
export interface ProviderParityRow {
	readonly provider: string;
	readonly catalogProductIds: readonly string[];
	readonly resolvedProductIds: readonly string[];
	readonly level: SimulatedParityLevel;
	/** Always `"<resolved>/<catalog>"` — a claim without one is not a claim. */
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

/**
 * Parses one provider's catalog and resolved ids into a parity row.
 *
 * Refuses rather than repairs: blank provider or product ids, an empty catalog,
 * or a resolved id the catalog does not declare all throw a typed ParityError.
 */
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

/** The namespaces this package publishes, in the order rows are returned. */
// public-contract: the provider rows providerParity() returns and their order.
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

/**
 * Where each row's two halves come from.
 *
 * Vercel's catalog is read with its opt-in `project()` row enabled. The bare
 * `vercel.Yard()` omits that row (a Project is configuration a caller asks
 * for, not a default web target), yet `vercel.project/v1` is an allocatable
 * Vercel offering with a shipped resolver. Measuring against the bare default
 * would either refuse (resolved id not in catalog) or, if the refusal were
 * relaxed, hide a working resolver. The full allocatable catalog is the honest
 * denominator; no other namespace has an opt-in row today.
 */
// public-contract: where each parity row's catalog and resolved halves are read from.
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

/** Every namespace's parity, derived from its live catalog and constants. */
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

/** Per-profile parity in provider order, then lexicographic profile order. */
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

/**
 * Re-derives and renders a row so caller-supplied level or denominator fields
 * cannot fabricate a claim.
 *
 * Example format (illustrative, not a current claim):
 * `acme L1-DECLARED: 1/3 resolvers declared (conformance not asserted here)`.
 */
export function formatParityClaim(row: ProviderParityRow): string {
	const derived = parityRow(
		row.provider,
		row.catalogProductIds,
		row.resolvedProductIds,
	);
	return `${derived.provider} ${derived.level}: ${derived.denominator} ${LEVEL_EVIDENCE[derived.level]}`;
}
