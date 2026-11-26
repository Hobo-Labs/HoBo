/**
 * Station capability coverage: what the Station's Yards *can allocate*,
 * aggregated into one auditable report, plus the gaps where nothing can.
 *
 * `capabilities.ts` answers "what facilities does the host under this Station
 * offer its occupants" (runtime, vcs, pam, replay …) by matching declarations
 * against host observations. This module answers the sibling question one
 * layer out: "which ADR-0151 capability profiles can this Station satisfy at
 * all, through which Yards, on which providers, and which expected profiles
 * can it not satisfy". Same fail-closed posture, same deep-frozen derived
 * record, different evidence source.
 *
 * Three properties are load-bearing and easy to lose:
 *
 * 1. **A Yard is a catalog, not an inventory** (ADR-0157 decision 1). A row
 *    says the Yard is *able to* allocate an offering for a profile. It is not
 *    a selection, a pool, or a record of anything running. Several rows per
 *    profile is therefore the normal case, not a conflict: Azure's `web` is
 *    legitimately Static Web Apps *and* App Service *and* Container Apps *and*
 *    AKS. Aggregation reports **coverage breadth** — how many distinct
 *    offerings, in which Yards, on which providers.
 *
 * 2. **This never ranks and never picks a winner.** Ordering here is a
 *    canonical lexicographic sort on identifiers so two equal inputs produce
 *    one output; it carries no preference. Selection is ADR-0151's job at
 *    resolution time — hard gates then lexicographic ordering. An aggregation
 *    that chose an offering would be a second, unversioned selection point,
 *    which ADR-0151 decision 11 and ADR-0157 decision 4 both forbid.
 *
 * 3. **Nothing is silently dropped.** A malformed catalog, a bad profile id,
 *    or a row constraining neither offering is a typed refusal, never a
 *    skipped row — a dropped row would understate coverage, and understated
 *    coverage is a portability lie in the same family as an overstated one.
 *
 * Determinism: the report is a pure function of its input and carries **no
 * timestamp**. Nothing about coverage depends on when it was computed (same
 * reasoning as the localhost Yard seed record), and a `generatedAt` would make
 * two equal inputs compare unequal — comparability is the whole value of this
 * record. No clock, no randomness, no ambient environment is read.
 */

// public-contract: wire schema of the Station capability coverage report.
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const STATION_CAPABILITY_COVERAGE_SCHEMA =
	"hobo.station-capability-coverage/v1" as const;

/** Capability profile id grammar (ADR-0151): `<primitive-family>.<path>/v<major>`. */
export const STATION_CAPABILITY_PROFILE_PATTERN =
	/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v[1-9][0-9]*$/u;

/**
 * One catalog row, restated **structurally**.
 *
 * This mirrors `YardBindingInput` from `@hobo/yards` on purpose and does not
 * import it: `@hobo/stations` depends on bindles/connectivity/core/dispatcher
 * only, and Station is not app-topology containment (ADR-0131 — Bindle ⊂ Camp
 * ⊂ Yard ⊂ Junction; a Station *seeds* a Yard, it does not contain one). Yard
 * catalogs already travel as plain data elsewhere in this repo for exactly
 * that reason, so aggregation takes the data and leaves the layer dependency
 * un-taken. `require`/`properties` are deliberately absent: coverage needs
 * only identity, and a record that never accepts realization parameters can
 * never carry a credential-shaped one.
 */
export interface StationYardBindingRowInput {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
}

/** One Yard's allocatable catalog as seen by the Station. */
export interface StationYardCatalogInput {
	readonly yardName: string;
	readonly providerId: string;
	readonly bindings: readonly StationYardBindingRowInput[];
}

export interface AggregateStationCapabilitiesInput {
	readonly stationId: string;
	readonly yards: readonly StationYardCatalogInput[];
	/** Capability profiles this Station is expected to be able to satisfy. */
	readonly expected: readonly string[];
}

/** One place a profile can be allocated. Identity only — never parameters. */
export interface StationCapabilityOffering {
	readonly yardName: string;
	readonly providerId: string;
	readonly productId?: string;
	readonly connectivityId?: string;
}

export interface ServedStationCapability {
	readonly profile: string;
	/** Every offering that can satisfy the profile. Breadth, not a choice. */
	readonly offerings: readonly StationCapabilityOffering[];
	readonly offeringCount: number;
	readonly yardNames: readonly string[];
	readonly providerIds: readonly string[];
	/** True when the profile is in the expected set; extra breadth is still reported. */
	readonly expected: boolean;
}

export interface StationCapabilityGap {
	readonly profile: string;
	readonly remediation: string;
}

/**
 * Factual dependency accounting, not a score. "Every capability here is
 * Cloudflare" should be visible without arithmetic; whether that is
 * acceptable is a policy question this record does not answer.
 */
export interface StationProviderConcentration {
	readonly providerId: string;
	readonly offeringCount: number;
	readonly profiles: readonly string[];
	readonly yardNames: readonly string[];
	/** Profiles no other provider on this Station can satisfy. */
	readonly soleSourceProfiles: readonly string[];
}

export interface StationCapabilityCoverage {
	readonly schema: typeof STATION_CAPABILITY_COVERAGE_SCHEMA;
	readonly stationId: string;
	/** True when every expected profile has at least one offering. */
	readonly ok: boolean;
	readonly served: readonly ServedStationCapability[];
	readonly gaps: readonly StationCapabilityGap[];
	/**
	 * Profiles served by exactly one offering. A resilience signal, not an
	 * error: one catalog edit away from a gap.
	 */
	readonly singlySourced: readonly string[];
	readonly providerConcentration: readonly StationProviderConcentration[];
	readonly yardNames: readonly string[];
	readonly expected: readonly string[];
}

export type StationCapabilityCoverageErrorCode =
	| "STATION_COVERAGE_STATION_INVALID"
	| "STATION_COVERAGE_YARD_INVALID"
	| "STATION_COVERAGE_DUPLICATE_YARD"
	| "STATION_COVERAGE_ROW_INVALID"
	| "STATION_COVERAGE_PROFILE_INVALID"
	| "STATION_COVERAGE_EMPTY_CONSTRAINT"
	| "STATION_COVERAGE_DUPLICATE_ROW"
	| "STATION_COVERAGE_EXPECTED_INVALID";

/** Typed refusal. Every instance names what to change, never just what broke. */
export class StationCapabilityCoverageError extends Error {
	readonly code: StationCapabilityCoverageErrorCode;
	readonly remediation: string;
	readonly yardName?: string;
	readonly profile?: string;

	constructor(
		code: StationCapabilityCoverageErrorCode,
		message: string,
		remediation: string,
		context?: { readonly yardName?: string; readonly profile?: string },
	) {
		super(message);
		this.name = "StationCapabilityCoverageError";
		this.code = code;
		this.remediation = remediation;
		if (context?.yardName !== undefined) this.yardName = context.yardName;
		if (context?.profile !== undefined) this.profile = context.profile;
	}
}

function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		return Object.freeze(value);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function isPlainObject<T>(value: T): value is T & JsonObject {
	return (
		isJsonObject(value) &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function compareStrings(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

function sortedUnique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort(compareStrings);
}

function parseProfile(
	value: JsonValue | undefined,
	origin: string,
	context?: { readonly yardName?: string },
): string {
	if (!isJsonString(value) || !STATION_CAPABILITY_PROFILE_PATTERN.test(value)) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_PROFILE_INVALID",
			`${origin} must match <primitive-family>.<path>/v<major> (got ${JSON.stringify(value)})`,
			"rewrite the profile id to the ADR-0151 grammar, e.g. data.postgres/v1",
			{
				...(context?.yardName !== undefined
					? { yardName: context.yardName }
					: undefined),
				...(isJsonString(value) ? { profile: value } : undefined),
			},
		);
	}
	return value;
}

/**
 * An absent constraint is legal on its own (the sibling may carry the row);
 * a present-but-empty one is authoring garbage and is refused rather than
 * normalized away — mirrors the Yard binding parse boundary.
 */
function parseConstraint(
	value: JsonValue | undefined,
	field: "productId" | "connectivityId",
	yardName: string,
	profile: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (!isJsonString(value) || value.length === 0) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_EMPTY_CONSTRAINT",
			`yard ${yardName} row for ${profile}: ${field} must be a non-empty string when present`,
			`remove ${field} from the row or give it the offering id it names`,
			{ yardName, profile },
		);
	}
	return value;
}

/** Internal pair: the profile a row covers plus the offering that covers it. */
interface ParsedOffering {
	readonly profile: string;
	readonly offering: StationCapabilityOffering;
}

function parseCatalog(
	catalog: StationYardCatalogInput,
): readonly ParsedOffering[] {
	if (!isPlainObject(catalog)) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_YARD_INVALID",
			`yard catalog must be an object (got ${JSON.stringify(catalog)})`,
			"pass { yardName, providerId, bindings } per Yard",
		);
	}
	const { yardName, providerId, bindings } = catalog;
	if (!isJsonString(yardName) || yardName.length === 0) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_YARD_INVALID",
			"yard catalog yardName must be a non-empty string",
			"name the Yard the catalog came from, e.g. yard:local",
		);
	}
	if (!isJsonString(providerId) || providerId.length === 0) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_YARD_INVALID",
			`yard ${yardName} catalog providerId must be a non-empty string`,
			"name the provider whose offerings this Yard publishes, e.g. cloudflare",
			{ yardName },
		);
	}
	if (!Array.isArray(bindings)) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_YARD_INVALID",
			`yard ${yardName} catalog bindings must be an array`,
			"pass an array of rows (an empty array declares an empty catalog)",
			{ yardName },
		);
	}

	const offerings: ParsedOffering[] = [];
	const seen = new Set<string>();
	for (const row of bindings) {
		if (!isPlainObject(row)) {
			throw new StationCapabilityCoverageError(
				"STATION_COVERAGE_ROW_INVALID",
				`yard ${yardName} binding row must be an object (got ${JSON.stringify(row)})`,
				"pass { profile, productId?, connectivityId? } per row",
				{ yardName },
			);
		}
		const profile = parseProfile(row.profile, "yard binding profile", {
			yardName,
		});
		const productId = parseConstraint(
			row.productId,
			"productId",
			yardName,
			profile,
		);
		const connectivityId = parseConstraint(
			row.connectivityId,
			"connectivityId",
			yardName,
			profile,
		);
		if (productId === undefined && connectivityId === undefined) {
			throw new StationCapabilityCoverageError(
				"STATION_COVERAGE_EMPTY_CONSTRAINT",
				`yard ${yardName} row for ${profile} constrains neither productId nor connectivityId`,
				"name the product or connectivity implementation that satisfies the profile — a row that constrains neither claims coverage it does not have",
				{ yardName, profile },
			);
		}
		const key = JSON.stringify([
			profile,
			productId ?? "",
			connectivityId ?? "",
		]);
		if (seen.has(key)) {
			throw new StationCapabilityCoverageError(
				"STATION_COVERAGE_DUPLICATE_ROW",
				`yard ${yardName} declares the same offering twice for ${profile} (productId ${productId ?? "-"}, connectivityId ${connectivityId ?? "-"})`,
				"remove the duplicate row — counting it twice would overstate coverage breadth",
				{ yardName, profile },
			);
		}
		seen.add(key);
		offerings.push({
			profile,
			offering: {
				yardName,
				providerId,
				...(productId !== undefined ? { productId } : undefined),
				...(connectivityId !== undefined ? { connectivityId } : undefined),
			},
		});
	}
	return offerings;
}

function compareOfferings(
	a: StationCapabilityOffering,
	b: StationCapabilityOffering,
): number {
	const byYard = compareStrings(a.yardName, b.yardName);
	if (byYard !== 0) return byYard;
	const byProduct = compareStrings(a.productId ?? "", b.productId ?? "");
	if (byProduct !== 0) return byProduct;
	const byConnectivity = compareStrings(
		a.connectivityId ?? "",
		b.connectivityId ?? "",
	);
	if (byConnectivity !== 0) return byConnectivity;
	return compareStrings(a.providerId, b.providerId);
}

function gapRemediation(profile: string, yardNames: readonly string[]): string {
	if (yardNames.length === 0) {
		return `no Yard on this Station declares an offering for ${profile}; this Station has no Yard catalogs — attach a Yard whose provider publishes one`;
	}
	return `no Yard on this Station declares an offering for ${profile}; add a row to a Yard whose provider publishes one (yards on this Station: ${yardNames.join(", ")})`;
}

/**
 * Aggregate the Station's Yard catalogs into one coverage report.
 *
 * Parse boundary: every refusal happens here, so downstream readers receive a
 * deep-frozen derived record and never a raw catalog. Fail-closed — a
 * malformed catalog refuses the whole aggregation rather than yielding a
 * partial report that reads as complete.
 */
export function aggregateStationCapabilities(
	input: AggregateStationCapabilitiesInput,
): StationCapabilityCoverage {
	if (!isPlainObject(input)) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_STATION_INVALID",
			"aggregate input must be an object",
			"pass { stationId, yards, expected }",
		);
	}
	const { stationId, yards, expected } = input;
	if (!isJsonString(stationId) || stationId.length === 0) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_STATION_INVALID",
			"stationId must be a non-empty string",
			"name the Station the coverage is reported for, e.g. station:local",
		);
	}
	if (!Array.isArray(yards)) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_YARD_INVALID",
			"yards must be an array of Yard catalogs",
			"pass an array (an empty array is a Station with no Yards, which reports every expected profile as a gap)",
		);
	}
	if (!Array.isArray(expected)) {
		throw new StationCapabilityCoverageError(
			"STATION_COVERAGE_EXPECTED_INVALID",
			"expected must be an array of capability profile ids",
			"pass the profiles this Station is supposed to be able to satisfy",
		);
	}

	const expectedProfiles = sortedUnique(
		expected.map((profile) => parseProfile(profile, "expected profile")),
	);

	const seenYards = new Set<string>();
	const offerings: ParsedOffering[] = [];
	for (const catalog of yards) {
		const parsed = parseCatalog(catalog);
		const yardName = catalog.yardName;
		if (seenYards.has(yardName)) {
			throw new StationCapabilityCoverageError(
				"STATION_COVERAGE_DUPLICATE_YARD",
				`yard ${yardName} appears twice in the Station's catalogs`,
				"pass each Yard once — a repeated Yard would double-count its offerings",
				{ yardName },
			);
		}
		seenYards.add(yardName);
		offerings.push(...parsed);
	}

	const yardNames = sortedUnique([...seenYards]);
	const expectedSet = new Set(expectedProfiles);

	const byProfile = new Map<string, StationCapabilityOffering[]>();
	for (const { profile, offering } of offerings) {
		const bucket = byProfile.get(profile);
		if (bucket === undefined) {
			byProfile.set(profile, [offering]);
		} else {
			bucket.push(offering);
		}
	}

	const served: ServedStationCapability[] = [];
	for (const profile of [...byProfile.keys()].sort(compareStrings)) {
		const rows = [...(byProfile.get(profile) ?? [])].sort(compareOfferings);
		served.push({
			profile,
			offerings: rows,
			offeringCount: rows.length,
			yardNames: sortedUnique(rows.map((row) => row.yardName)),
			providerIds: sortedUnique(rows.map((row) => row.providerId)),
			expected: expectedSet.has(profile),
		});
	}

	const gaps: StationCapabilityGap[] = expectedProfiles
		.filter((profile) => !byProfile.has(profile))
		.map((profile) => ({
			profile,
			remediation: gapRemediation(profile, yardNames),
		}));

	const singlySourced = served
		.filter((entry) => entry.offeringCount === 1)
		.map((entry) => entry.profile);

	return deepFreeze({
		schema: STATION_CAPABILITY_COVERAGE_SCHEMA,
		stationId,
		ok: gaps.length === 0,
		served,
		gaps,
		singlySourced,
		providerConcentration: concentration(served),
		yardNames,
		expected: expectedProfiles,
	});
}

/**
 * Which providers the coverage depends on. Factual: counts and the profiles
 * only that provider can satisfy on this Station. No score, no threshold, no
 * judgement about whether the concentration is acceptable — that is a policy
 * question, and answering it here would smuggle a preference into a record
 * whose whole point is that it has none.
 */
function concentration(
	served: readonly ServedStationCapability[],
): readonly StationProviderConcentration[] {
	const providers = new Map<
		string,
		{ offeringCount: number; profiles: string[]; yardNames: string[] }
	>();
	for (const entry of served) {
		for (const offering of entry.offerings) {
			const bucket = providers.get(offering.providerId) ?? {
				offeringCount: 0,
				profiles: [],
				yardNames: [],
			};
			bucket.offeringCount += 1;
			bucket.profiles.push(entry.profile);
			bucket.yardNames.push(offering.yardName);
			providers.set(offering.providerId, bucket);
		}
	}
	return [...providers.entries()]
		.sort(([a], [b]) => compareStrings(a, b))
		.map(([providerId, bucket]) => ({
			providerId,
			offeringCount: bucket.offeringCount,
			profiles: sortedUnique(bucket.profiles),
			yardNames: sortedUnique(bucket.yardNames),
			soleSourceProfiles: served
				.filter(
					(entry) =>
						entry.providerIds.length === 1 &&
						entry.providerIds[0] === providerId,
				)
				.map((entry) => entry.profile),
		}));
}

/**
 * Short deterministic digest for `hobo station status`. Gaps first: an
 * operator reading three lines should learn what the Station cannot do before
 * what it can. Plain text on purpose — no TUI or design-system dependency, so
 * this stays usable from a log line, a receipt, or a test assertion.
 */
export function renderStationCapabilityCoverage(
	coverage: StationCapabilityCoverage,
): string {
	const lines: string[] = [
		`station ${coverage.stationId} capability coverage: ${coverage.ok ? "ok" : "INCOMPLETE"} — ${coverage.served.length} profile(s) served across ${coverage.yardNames.length} yard(s), ${coverage.gaps.length} gap(s), ${coverage.singlySourced.length} singly sourced`,
	];
	for (const gap of coverage.gaps) {
		lines.push(`  gap  ${gap.profile} — ${gap.remediation}`);
	}
	for (const entry of coverage.served) {
		const offerings = entry.offerings
			.map(
				(offering) =>
					`${offering.yardName}/${offering.providerId}/${offering.productId ?? offering.connectivityId ?? "-"}`,
			)
			.join(", ");
		const flags = [
			entry.offeringCount === 1 ? "singly sourced" : undefined,
			entry.expected ? undefined : "beyond expected set",
		].filter((flag): flag is string => flag !== undefined);
		const suffix = flags.length > 0 ? ` [${flags.join("; ")}]` : "";
		lines.push(
			`  ok   ${entry.profile} — ${entry.offeringCount} offering(s)${suffix}: ${offerings}`,
		);
	}
	for (const provider of coverage.providerConcentration) {
		lines.push(
			`  via  ${provider.providerId} — ${provider.offeringCount} offering(s), ${provider.profiles.length} profile(s), ${provider.soleSourceProfiles.length} sole-sourced`,
		);
	}
	if (coverage.served.length === 0 && coverage.gaps.length === 0) {
		lines.push("  none  no Yard catalogs and no expected profiles");
	}
	return lines.join("\n");
}
