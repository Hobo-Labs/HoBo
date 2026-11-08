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
 *   - `L1` — simulated: resolver ids exist, proven against an injected fake
 *     transport in the provider package.
 *   - `L2` — local-live: the six lifecycle cases against real local processes.
 *   - `L3` — local-DX: a timed offline script, minutes recorded.
 *   - `P2` / `P3` — cloud live / cloud DX. Fallback claims only.
 *
 * HONEST BY CONSTRUCTION: this layer can only see constants, so it can only
 * ever emit `P0` or `L1`. `L2`/`L3`/`P2`/`P3` require *executed* evidence that
 * later layers own; a projection over static data that printed one of them
 * would be exactly the overclaim this module exists to remove.
 *
 * This is a read model, not a decision (see ADR.md): it does not select,
 * filter, or reorder Yard rows. A resolved id the catalog does not declare is
 * refused with a typed error rather than dropped, because silently dropping it
 * would make the denominator look tidier than the code is.
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

/**
 * The closed level vocabulary, local levels before cloud fallbacks. The CUE
 * `#ParityLevel` in data-models/provider_catalog.cue is the same set; a test
 * pins the two together.
 */
// public-contract: the parity level vocabulary; the CUE #ParityLevel set and every rendered claim depend on it.
export const PARITY_LEVELS = Object.freeze([
	"P0",
	"L1",
	"L2",
	"L3",
	"P2",
	"P3",
] as const);

export type ParityLevel = (typeof PARITY_LEVELS)[number];

/** The only levels a constants-only projection may emit. */
export type SimulatedParityLevel = Extract<ParityLevel, "P0" | "L1">;

// public-contract: refusal codes callers may branch on.
export type ParityErrorCode =
	| "PARITY_PROVIDER_EMPTY"
	| "PARITY_RESOLVED_NOT_IN_CATALOG";

export class ParityError extends Error {
	readonly code: ParityErrorCode;

	constructor(code: ParityErrorCode, message: string) {
		super(message);
		this.name = "ParityError";
		this.code = code;
	}
}

/** One provider's derived parity. Field names mirror `ProviderParityRowRecord`. */
export interface ProviderParityRow {
	readonly provider: string;
	readonly catalogProductIds: readonly string[];
	readonly resolvedProductIds: readonly string[];
	readonly level: SimulatedParityLevel;
	/** Always `"<resolved>/<catalog>"` — a claim without one is not a claim. */
	readonly denominator: string;
}

function canonicalIds(ids: Iterable<string>): readonly string[] {
	return Object.freeze([...new Set(ids)].sort());
}

/**
 * Parses one provider's catalog and resolved ids into a parity row.
 *
 * Refuses rather than repairs: an empty provider id, or a resolved id the
 * catalog does not declare (`PARITY_RESOLVED_NOT_IN_CATALOG`), throws.
 */
export function parityRow(
	provider: string,
	catalogProductIds: Iterable<string>,
	resolvedProductIds: Iterable<string>,
): ProviderParityRow {
	if (provider === "") {
		throw new ParityError(
			"PARITY_PROVIDER_EMPTY",
			"A parity row must name its provider.",
		);
	}
	const catalog = canonicalIds(catalogProductIds);
	const resolved = canonicalIds(resolvedProductIds);
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
		level: resolved.length > 0 ? "L1" : "P0",
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

type ParityProvider = (typeof PARITY_PROVIDERS)[number];

interface ParitySource {
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
const SOURCES: Readonly<Record<ParityProvider, ParitySource>> = Object.freeze({
	aws: { catalog: () => aws.Yard(), resolved: AWS_RESOLVED_PRODUCT_IDS },
	azure: { catalog: () => azure.Yard(), resolved: AZURE_RESOLVED_PRODUCT_IDS },
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

/** Every namespace's parity, derived from its live catalog and constants. */
export function providerParity(): readonly ProviderParityRow[] {
	return Object.freeze(
		PARITY_PROVIDERS.map((provider) => {
			const source = SOURCES[provider];
			return parityRow(
				provider,
				productIdsOf(source.catalog()),
				source.resolved,
			);
		}),
	);
}

const LEVEL_EVIDENCE: Readonly<Record<SimulatedParityLevel, string>> =
	Object.freeze({
		P0: "catalog only",
		L1: "simulated (fake-transport)",
	});

/** `"aws L1: 8/19 simulated (fake-transport)"` — the denominator is never omitted. */
export function formatParityClaim(row: ProviderParityRow): string {
	return `${row.provider} ${row.level}: ${row.denominator} ${LEVEL_EVIDENCE[row.level]}`;
}
