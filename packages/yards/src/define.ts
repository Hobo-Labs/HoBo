/**
 * Slot-keyed Yard authoring — the ergonomic surface that **compiles down to**
 * the binding rows `yard()` already parses (ADR-0157).
 *
 * Today an operator authors a Yard by typing raw rows:
 * `{ profile: "data.postgres/v1", productId: "aws.rds-postgres/v1", … }`.
 * Those rows are the planner's IR. They are the right thing to *store* and the
 * wrong thing to *type*: a magic string carries no autocomplete, no slot
 * vocabulary, and no check that the row you wrote belongs where you put it.
 *
 * This module makes the rows a compile target. Three properties are
 * load-bearing and easy to lose:
 *
 * 1. **It compiles, it does not parse.** Every authored value still crosses the
 *    existing `yard()` / `parseYardBindings()` boundary — canonicalization,
 *    credential screening, duplicate refusal, pin-conflict refusal and deep
 *    freezing all happen exactly once, in the code that already ships. A second
 *    parser here would be a second opinion about what a credential is.
 * 2. **Slot and profile must agree.** A `bucket` slot holding
 *    `data.postgres/v1` is a defect, not a preference: the slot vocabulary is
 *    the capability the app asked for, and a row filed under the wrong one
 *    would silently constrain a capability nobody named. It is refused with
 *    `SLOT_PROFILE_MISMATCH`.
 * 3. **Authoring order is not information.** Slots are compiled in the fixed
 *    `CAPABILITY_SLOTS` order, never in object-key order, so two authors who
 *    type the same slots in different orders get deep-equal Yards. (Rows are a
 *    set — ADR-0151 forbids authoring order reaching selection.)
 *
 * `defineStation` lives here for the same reason and with one sharp caveat: a
 * Station is control-plane **occupancy** and is never a parent of a Yard
 * (ADR-0131 fixes `Bindle ⊂ Camp ⊂ Yard ⊂ Junction` as the containment axis,
 * and Station is not on it). So `defineStation` emits a **registration**
 * manifest — "the Yards this Station's conductor brokers" — and deliberately
 * does not import `@hobo/stations`: the composition root hands the manifest to
 * `station()`, keeping Stations free of any Yard coupling.
 */
import type { Camp } from "@hobo/camps";
import {
	CAPABILITY_SLOTS,
	type CapabilitySlot,
	SLOT_BINDING_CONTRACT,
	type SlotBinding,
} from "@hobo/core";
import {
	YARD_BINDING_PROFILE_PATTERN,
	type YardBindingInput,
} from "./binding.js";
import { deepFreeze, isPlainObject, requireName } from "./canonical.js";
import { isJsonString } from "./json.js";
import { type Yard, yard } from "./yard.js";

export const STATION_MANIFEST_CONTRACT = "hobo.station-manifest/v1"; // public-contract: contract id on every station manifest

export type YardDefineErrorCode =
	| "SLOT_PROFILE_MISMATCH"
	| "SLOT_KEY_MISMATCH"
	| "YARD_REGION_CONFLICT";

export class YardDefineError extends Error {
	readonly code: YardDefineErrorCode;
	readonly slot?: CapabilitySlot;

	constructor(
		code: YardDefineErrorCode,
		message: string,
		slot?: CapabilitySlot,
	) {
		super(message);
		this.name = "YardDefineError";
		this.code = code;
		if (slot !== undefined) {
			this.slot = slot;
		}
	}
}

export type StationDefineErrorCode =
	| "STATION_NO_YARDS"
	| "STATION_DUPLICATE_YARD";

export class StationDefineError extends Error {
	readonly code: StationDefineErrorCode;
	readonly yardName?: string;

	constructor(
		code: StationDefineErrorCode,
		message: string,
		yardName?: string,
	) {
		super(message);
		this.name = "StationDefineError";
		this.code = code;
		if (yardName !== undefined) {
			this.yardName = yardName;
		}
	}
}

/**
 * Slot-keyed Yard authoring. Each slot accepts one `SlotBinding` (or several
 * for the same slot via an array — two buckets is legal), and compiles to the
 * `YardBindingInput` rows that `yard()` already parses.
 */
export type YardSlots = {
	readonly [K in CapabilitySlot]?: SlotBinding | readonly SlotBinding[];
};

export type DefineYardConfig = YardSlots & {
	readonly provider: string | { readonly id: string };
	/** Sugar for `regions: [region]`. */
	readonly region?: string;
	readonly regions?: readonly string[];
	readonly residency?: readonly string[];
	readonly componentHosts?: readonly string[];
	readonly labels?: Readonly<Record<string, string>>;
	readonly camps?: readonly Camp[];
};

export interface DefineStationConfig {
	readonly isolation?: {
		readonly tenant?: string;
		readonly residency?: string;
		readonly airgap?: boolean;
		readonly trustDomain?: string;
	};
	readonly yards: readonly Yard[];
}

export interface StationManifest {
	readonly contract: typeof STATION_MANIFEST_CONTRACT;
	readonly name: string;
	readonly isolation: Readonly<{
		tenant: string;
		residency: string;
		airgap: boolean;
		trustDomain: string;
	}>;
	/** Yard names, sorted. Registration, not containment (ADR-0131). */
	readonly yardRefs: readonly string[];
	readonly yards: readonly Yard[];
}

/**
 * Profile family → capability slot. The family is the profile's first
 * dot-segment (ADR-0151 grammar `<primitive-family>.<path>/v<major>`); it
 * equals the slot name except for the two ADR-0151 aliases below.
 */
const SLOT_BY_PROFILE_FAMILY: ReadonlyMap<string, CapabilitySlot> = new Map<
	string,
	CapabilitySlot
>([
	...CAPABILITY_SLOTS.map((slot): readonly [string, CapabilitySlot] => [
		slot,
		slot,
	]),
	["secret-ref", "secretRef"],
	["realtime", "webhook"],
]);

/**
 * Compiles slots to binding rows and returns a real `Yard` via the existing
 * `yard()` — no private construction path, so every refusal `yard()` makes
 * still fires here.
 */
export function defineYard(name: string, config: DefineYardConfig): Yard {
	requireName("yard name", name);
	if (!isPlainObject(config)) {
		throw new TypeError("defineYard config must be an object");
	}

	// Fixed slot order, never Object.keys(config): authoring order must not be
	// able to reach the record.
	const bindings: YardBindingInput[] = [];
	for (const slot of CAPABILITY_SLOTS) {
		const authored = config[slot];
		if (authored === undefined) continue;
		const entries = isSlotBindingList(authored) ? authored : [authored];
		if (entries.length === 0) {
			throw new TypeError(
				`defineYard slot ${slot} was authored as an empty array — omit the slot instead`,
			);
		}
		for (const entry of entries) {
			bindings.push(compileSlotBinding(slot, entry));
		}
	}

	return yard(name, {
		provider: config.provider,
		regions: resolveRegions(config.region, config.regions),
		...(config.residency !== undefined
			? { residency: config.residency }
			: undefined),
		...(config.componentHosts !== undefined
			? { componentHosts: config.componentHosts }
			: undefined),
		...(config.labels !== undefined ? { labels: config.labels } : undefined),
		bindings,
		camps: config.camps ?? [],
	});
}

/**
 * The slot a Yard row came from, for diagnostics. Derived from the row's
 * profile family rather than remembered, so it answers for hand-written rows
 * too; `undefined` when the Yard has no row for that profile, or the profile's
 * family is outside the slot vocabulary.
 */
export function slotOf(
	yardObject: Yard,
	profile: string,
): CapabilitySlot | undefined {
	if (!isYard(yardObject)) {
		throw new TypeError("slotOf requires a parsed Yard");
	}
	if (!isJsonString(profile)) {
		throw new TypeError("slotOf profile must be a string");
	}
	const row = yardObject.bindings.find((entry) => entry.profile === profile);
	if (row === undefined) return undefined;
	return SLOT_BY_PROFILE_FAMILY.get(profileFamily(row.profile));
}

/**
 * Emits the registration manifest for a Station's conductor. This is **not**
 * containment: a Station never parents a Yard (ADR-0131). The composition root
 * hands the manifest to `station()`; this package stays free of a `@hobo/stations`
 * import so Stations stay free of Yard coupling.
 */
export function defineStation(
	name: string,
	config: DefineStationConfig,
): StationManifest {
	requireName("station name", name);
	if (!isPlainObject(config)) {
		throw new TypeError("defineStation config must be an object");
	}
	const yards = config.yards;
	if (!Array.isArray(yards)) {
		throw new TypeError("defineStation yards must be an array");
	}
	if (yards.length === 0) {
		throw new StationDefineError(
			"STATION_NO_YARDS",
			`station ${name} registers no Yards — a Station brokering nothing is an authoring mistake, not an empty default; register the Yards its conductor brokers`,
		);
	}

	const names = new Set<string>();
	for (const entry of yards) {
		if (!isYard(entry)) {
			throw new TypeError("defineStation yards must be parsed Yard objects");
		}
		if (names.has(entry.name)) {
			throw new StationDefineError(
				"STATION_DUPLICATE_YARD",
				`station ${name} registers yard ${entry.name} twice — registration is a set; list each brokered Yard once`,
				entry.name,
			);
		}
		names.add(entry.name);
	}

	const isolation = config.isolation ?? {};
	return deepFreeze({
		contract: STATION_MANIFEST_CONTRACT,
		name,
		// Defaults mirror station() exactly, so handing this manifest to
		// station() cannot change the isolation it would otherwise have.
		isolation: {
			tenant: isolation.tenant ?? name,
			residency: isolation.residency ?? "local",
			airgap: isolation.airgap === true,
			trustDomain: isolation.trustDomain ?? `${name}.hobo.local`,
		},
		yardRefs: [...names].sort(),
		// Sorted by name for the same reason the refs are: registration order is
		// not information.
		yards: [...yards].sort(compareYardNames),
	});
}

function compileSlotBinding(
	slot: CapabilitySlot,
	binding: SlotBinding,
): YardBindingInput {
	if (!isPlainObject(binding)) {
		throw new TypeError(`slot binding for ${slot} must be an object`);
	}
	if (binding.contract !== SLOT_BINDING_CONTRACT) {
		throw new TypeError(
			`slot binding for ${slot} must carry contract ${SLOT_BINDING_CONTRACT} (got ${JSON.stringify(binding.contract)})`,
		);
	}
	if (binding.slot !== slot) {
		throw new YardDefineError(
			"SLOT_KEY_MISMATCH",
			`slot binding authored under ${slot} declares slot ${JSON.stringify(binding.slot)} — file it under the slot it declares`,
			slot,
		);
	}
	const profile = binding.profile;
	if (!isJsonString(profile)) {
		throw new TypeError(`slot binding for ${slot} must carry a profile string`);
	}
	// A malformed profile is left to `yard()` so the existing
	// YARD_BINDING_PROFILE_INVALID refusal keeps naming it; only a well-formed
	// profile can disagree with its slot.
	if (YARD_BINDING_PROFILE_PATTERN.test(profile)) {
		const expected = SLOT_BY_PROFILE_FAMILY.get(profileFamily(profile));
		if (expected !== slot) {
			throw new YardDefineError(
				"SLOT_PROFILE_MISMATCH",
				`slot ${slot} cannot hold profile ${profile}: its family "${profileFamily(profile)}" belongs to ${expected === undefined ? "no capability slot" : `slot ${expected}`} — a row filed under the wrong slot constrains a capability nobody asked for`,
				slot,
			);
		}
	}

	return {
		profile,
		...(binding.productId !== undefined
			? { productId: binding.productId }
			: undefined),
		...(binding.connectivityId !== undefined
			? { connectivityId: binding.connectivityId }
			: undefined),
		properties: binding.properties ?? {},
	};
}

/** The profile's family: everything before the first `.` or `/`. */
function profileFamily(profile: string): string {
	const cut = profile.search(/[./]/u);
	return cut === -1 ? profile : profile.slice(0, cut);
}

function isYard<T>(value: T): value is T & Yard {
	return isPlainObject(value) && value.kind === "yard";
}

function isSlotBindingList(
	value: SlotBinding | readonly SlotBinding[],
): value is readonly SlotBinding[] {
	return Array.isArray(value);
}

/**
 * `region` is sugar for a one-element `regions`. Authoring both is only legal
 * when they say the same thing — a Yard whose two region statements disagree
 * has no defensible answer, so it is refused rather than merged.
 */
function resolveRegions(
	region: string | undefined,
	regions: readonly string[] | undefined,
): readonly string[] {
	if (regions !== undefined && !Array.isArray(regions)) {
		throw new TypeError("defineYard regions must be an array");
	}
	if (region === undefined) return regions ?? [];
	if (!isJsonString(region) || region.length === 0) {
		throw new TypeError(
			"defineYard region must be a non-empty string when present",
		);
	}
	if (regions === undefined) return [region];
	const distinct = [...new Set(regions)];
	if (distinct.length !== 1 || distinct[0] !== region) {
		throw new YardDefineError(
			"YARD_REGION_CONFLICT",
			`defineYard region ${JSON.stringify(region)} disagrees with regions ${JSON.stringify(regions)} — author one of them, not both`,
		);
	}
	return [region];
}

function compareYardNames(a: Yard, b: Yard): number {
	if (a.name === b.name) return 0;
	return a.name < b.name ? -1 : 1;
}
