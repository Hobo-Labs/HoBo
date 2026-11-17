import { cloneAsJson, isJsonString, type JsonValue } from "../json.js";
import { deepFreeze, enumValue, expectObject } from "../parse-utils.js";
import {
	type DataStoreOfferingId,
	DataStoreOfferingParseError,
	type DataStoreProvider,
	type DataStoreProviderProfile,
	DEFAULT_DATA_STORE_FALLBACKS,
	dataStoreOffering,
	parseDataStoreFeatures,
	parseDataStoreFidelity,
	parseDataStoreOfferingId,
	parseDataStoreProvider,
	parseDataStoreStability,
} from "./data-store-offerings.js";
import type {
	OfferingFidelity,
	OfferingStability,
} from "./offering-resolution.js";

// public-contract: the realization vocabulary every catalog claim is written in.
export const DATA_STORE_CLAIM_REALIZATIONS = Object.freeze([
	"native",
	"fallback",
	"operator",
	"unsupported",
	"unknown",
] as const);

export type DataStoreClaimRealization =
	(typeof DATA_STORE_CLAIM_REALIZATIONS)[number];

// public-contract: who operates a catalogued store.
export const DATA_STORE_MANAGEMENT_MODES = Object.freeze([
	"managed",
	"self-hosted",
] as const);

export type DataStoreManagement = (typeof DATA_STORE_MANAGEMENT_MODES)[number];

// public-contract: the stability-basis vocabulary a catalog entry is written in.
export const DATA_STORE_STABILITY_BASES = Object.freeze([
	"vendor-stated",
	"inferred",
] as const);

export type DataStoreStabilityBasis =
	(typeof DATA_STORE_STABILITY_BASES)[number];

// domain-view: parse-time evidence reference; wire form is DataStoreClaimSourceRecord in data-models/data_store_catalog.proto.
export interface DataStoreClaimSource {
	readonly url: string;
	readonly checkedAt: string;
	readonly note: string;
}

// domain-view: parsed claim with typed ids; wire form is DataStoreCatalogClaimRecord in data-models/data_store_catalog.proto.
export interface DataStoreCatalogClaim {
	readonly offering: DataStoreOfferingId;
	readonly realization: DataStoreClaimRealization;
	readonly stability: OfferingStability;
	readonly fidelity: OfferingFidelity;
	readonly features: readonly string[];
	readonly detail: string;
	readonly sources: readonly DataStoreClaimSource[];
}

// domain-view: parsed catalog entry with typed ids; wire form is DataStoreCatalogEntryRecord in data-models/data_store_catalog.proto.
export interface DataStoreCatalogEntry {
	readonly provider: DataStoreProvider;
	readonly vendor: string;
	readonly product: string;
	readonly management: DataStoreManagement;
	readonly stability: OfferingStability;
	readonly stabilityBasis: DataStoreStabilityBasis;
	readonly stabilitySources: readonly DataStoreClaimSource[];
	readonly yardProductId?: string;
	readonly claims: readonly DataStoreCatalogClaim[];
}

export interface DataStoreCatalogEvidenceSummary {
	readonly provider: DataStoreProvider;
	readonly evidenced: number;
	readonly unknown: number;
}

const REALIZATIONS = new Set<DataStoreClaimRealization>(
	DATA_STORE_CLAIM_REALIZATIONS,
);
const MANAGEMENT = new Set<DataStoreManagement>(DATA_STORE_MANAGEMENT_MODES);
const STABILITY_BASES = new Set<DataStoreStabilityBasis>(
	DATA_STORE_STABILITY_BASES,
);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function parseDataStoreClaimSource(
	value: JsonValue | undefined,
	path = "source",
): DataStoreClaimSource {
	const input = expectObject(value, path, DataStoreOfferingParseError);
	const url = text(input.url, `${path}.url`);
	if (!URL.canParse(url) || new URL(url).protocol !== "https:") {
		fail(`${path}.url`, "https URL", input.url);
	}
	const checkedAt = text(input.checkedAt, `${path}.checkedAt`);
	if (
		!ISO_DATE.test(checkedAt) ||
		Number.isNaN(Date.parse(`${checkedAt}T00:00:00Z`))
	) {
		fail(`${path}.checkedAt`, "YYYY-MM-DD date", input.checkedAt);
	}
	return deepFreeze({
		url,
		checkedAt,
		note: text(input.note, `${path}.note`),
	});
}

export function parseDataStoreCatalogClaim(
	value: JsonValue | undefined,
	path = "claim",
): DataStoreCatalogClaim {
	const input = expectObject(value, path, DataStoreOfferingParseError);
	const realization = enumValue(
		input.realization,
		REALIZATIONS,
		`${path}.realization`,
		DataStoreOfferingParseError,
	);
	const sources = sourceList(input.sources, `${path}.sources`);
	const detail = isJsonString(input.detail) ? input.detail.trim() : "";
	if (realization === "unknown" && detail.length === 0) {
		fail(`${path}.detail`, "what could not be confirmed", input.detail);
	}
	if (realization !== "unknown" && sources.length === 0) {
		fail(`${path}.sources`, "at least one dated source", input.sources);
	}
	return deepFreeze({
		offering: parseDataStoreOfferingId(input.offering, `${path}.offering`),
		realization,
		stability: parseDataStoreStability(input.stability, `${path}.stability`),
		fidelity: parseDataStoreFidelity(input.fidelity, `${path}.fidelity`),
		features: parseDataStoreFeatures(input.features, `${path}.features`),
		detail,
		sources,
	});
}

export function parseDataStoreCatalogEntry(
	value: JsonValue | undefined,
	path = "entry",
): DataStoreCatalogEntry {
	const input = expectObject(value, path, DataStoreOfferingParseError);
	const claims = (
		Array.isArray(input.claims)
			? input.claims
			: fail(`${path}.claims`, "claims array", input.claims)
	).map((entry, index) =>
		parseDataStoreCatalogClaim(entry, `${path}.claims[${index}]`),
	);
	if (new Set(claims.map((claim) => claim.offering)).size !== claims.length) {
		fail(`${path}.claims`, "one claim per offering id", input.claims);
	}
	const stabilitySources = sourceList(
		input.stabilitySources,
		`${path}.stabilitySources`,
	);
	if (stabilitySources.length === 0) {
		fail(
			`${path}.stabilitySources`,
			"at least one dated source",
			input.stabilitySources,
		);
	}
	const entry = {
		provider: parseDataStoreProvider(input.provider, `${path}.provider`),
		vendor: text(input.vendor, `${path}.vendor`),
		product: text(input.product, `${path}.product`),
		management: enumValue(
			input.management,
			MANAGEMENT,
			`${path}.management`,
			DataStoreOfferingParseError,
		),
		stability: parseDataStoreStability(input.stability, `${path}.stability`),
		stabilityBasis: enumValue(
			input.stabilityBasis,
			STABILITY_BASES,
			`${path}.stabilityBasis`,
			DataStoreOfferingParseError,
		),
		stabilitySources,
		claims: deepFreeze(claims),
	};
	return deepFreeze(
		input.yardProductId === undefined
			? entry
			: {
					...entry,
					yardProductId: text(input.yardProductId, `${path}.yardProductId`),
				},
	);
}

export function dataStoreProfileOf(
	entry: DataStoreCatalogEntry,
): DataStoreProviderProfile {
	const native = entry.claims.filter((claim) => claim.realization === "native");
	const nativeIds = new Set(native.map((claim) => claim.offering));
	const ladder = [
		...entry.claims
			.filter(
				(claim) =>
					claim.realization === "operator" || claim.realization === "fallback",
			)
			.map((claim) => claim.offering),
		...DEFAULT_DATA_STORE_FALLBACKS,
	].filter((id) => !nativeIds.has(id));
	return deepFreeze({
		provider: entry.provider,
		offerings: native.map((claim) =>
			dataStoreOffering(claim.offering, {
				stability: leastStable(entry.stability, claim.stability),
				fidelity: claim.fidelity,
				features: claim.features,
			}),
		),
		fallbacks: [...new Set(ladder)],
	});
}

export function operatorOwnedOfferings(
	entry: DataStoreCatalogEntry,
): readonly DataStoreOfferingId[] {
	return deepFreeze(
		entry.claims
			.filter((claim) => claim.realization === "operator")
			.map((claim) => claim.offering),
	);
}

export function dataStoreCatalogEvidence(
	entry: DataStoreCatalogEntry,
): DataStoreCatalogEvidenceSummary {
	const unknown = entry.claims.filter(
		(claim) => claim.realization === "unknown",
	).length;
	return deepFreeze({
		provider: entry.provider,
		evidenced: entry.claims.length - unknown,
		unknown,
	});
}

const STABILITY_RANK: Readonly<Record<OfferingStability, number>> =
	Object.freeze({ stable: 0, preview: 1, experimental: 2 });

function leastStable(
	left: OfferingStability,
	right: OfferingStability,
): OfferingStability {
	return STABILITY_RANK[left] >= STABILITY_RANK[right] ? left : right;
}

function sourceList(
	value: JsonValue | undefined,
	path: string,
): readonly DataStoreClaimSource[] {
	if (value === undefined) return deepFreeze([]);
	if (!Array.isArray(value)) return fail(path, "sources array", value);
	return deepFreeze(
		value.map((entry, index) =>
			parseDataStoreClaimSource(entry, `${path}[${index}]`),
		),
	);
}

function text(value: JsonValue | undefined, path: string): string {
	if (!isJsonString(value) || value.trim().length === 0) {
		return fail(path, "non-empty string", value);
	}
	return value.trim();
}

function fail<T>(path: string, expected: string, received: T): never {
	throw new DataStoreOfferingParseError(path, expected, cloneAsJson(received));
}
