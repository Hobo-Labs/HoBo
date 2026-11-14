import {
	attachCampToYard,
	type Camp,
	EMPTY_RESOLVER_CONFIG,
	type PrimitiveResolverConfig,
} from "@hobo/camps";
import {
	parseYardBindings,
	type YardBinding,
	type YardBindingInput,
} from "./binding.js";
import {
	assertNoCredentials,
	canonicalizeLabels,
	canonicalizeProperties,
	canonicalizeStringList,
	deepFreeze,
	isPlainObject,
	requireName,
} from "./canonical.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

export const TOPOLOGY_CONTRACT_VERSION = "hobo.topology-objects/v1" as const;

/**
 * Yard is the provider-specific topology and control-plane boundary.
 * Provider is authored on the Yard — never derived from Camps.
 * Zero Camps are allowed (requested shape before live instance / generation).
 */
export interface Yard {
	readonly kind: "yard";
	readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
	readonly name: string;
	readonly providerId: string;
	/** Optional registered Yard-runtime family id. */
	readonly runtimeId?: string;
	readonly regions: readonly string[];
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly residency: readonly string[];
	readonly isolation: readonly string[];
	readonly network: readonly string[];
	readonly componentHosts: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	/** Provider-native refs only (no credentials). */
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly resolverDefaults: PrimitiveResolverConfig;
	/** Canonical set of capability-profile → provider-offering rows (ADR-0157). */
	readonly bindings: readonly YardBinding[];
	readonly camps: readonly Camp[];
}

export interface YardConfig {
	/**
	 * Provider id or factory result `{ id: string }` / string.
	 * Required: Yard is the only direct provider selection point.
	 */
	readonly provider: string | { readonly id: string };
	readonly runtimeId?: string;
	readonly regions?: readonly string[];
	readonly require?: readonly string[];
	readonly prefer?: readonly string[];
	readonly residency?: readonly string[];
	readonly isolation?: readonly string[];
	readonly network?: readonly string[];
	readonly componentHosts?: readonly string[];
	readonly labels?: Readonly<Record<string, string>>;
	readonly properties?: Readonly<Record<string, JsonValue>>;
	readonly resolverDefaults?: Partial<PrimitiveResolverConfig>;
	/** Capability binding rows; order is not preserved — they parse into a set. */
	readonly bindings?: readonly YardBindingInput[];
	/** Zero or more declared Camp shapes (may be empty). */
	readonly camps?: readonly Camp[];
}

export function yard(name: string, config: YardConfig): Yard {
	requireName("yard name", name);
	if (!isPlainObject(config)) {
		throw new TypeError("yard config must be an object");
	}
	const providerId = normalizeProvider(config.provider);
	const campsInput = config.camps ?? [];
	if (!Array.isArray(campsInput)) {
		throw new TypeError("yard camps must be an array");
	}
	for (const entry of campsInput) {
		if (entry?.kind !== "camp") {
			throw new TypeError("yard camps must be Camp objects");
		}
	}

	const attachedCamps = campsInput.map((c) =>
		attachCampToYard(c, {
			yardId: name,
			providerId,
		}),
	);

	const properties = canonicalizeProperties(config.properties ?? {});
	assertNoCredentials(properties);

	// Resolver pins and capability rows bind the same subject by different
	// mechanisms, so the pinned slots are handed to the row parser: authoring
	// both for one slot is a conflict, not a merge.
	const resolverDefaults = parseResolverDefaults(config.resolverDefaults);
	const bindings = parseYardBindings(config.bindings, {
		pinnedSlots: resolverDefaults.pins.map((pin) => pin.slot),
	});

	return deepFreeze({
		kind: "yard" as const,
		contract: TOPOLOGY_CONTRACT_VERSION,
		name,
		providerId,
		...(config.runtimeId !== undefined
			? { runtimeId: config.runtimeId }
			: undefined),
		regions: canonicalizeStringList(config.regions ?? []),
		require: canonicalizeStringList(config.require ?? []),
		prefer: canonicalizeStringList(config.prefer ?? []),
		residency: canonicalizeStringList(config.residency ?? []),
		isolation: canonicalizeStringList(config.isolation ?? []),
		network: canonicalizeStringList(config.network ?? []),
		componentHosts: canonicalizeStringList(config.componentHosts ?? []),
		labels: canonicalizeLabels(config.labels ?? {}),
		properties,
		resolverDefaults,
		bindings,
		camps: Object.freeze(attachedCamps),
	});
}

/** Project authored Yard into a planning contract record (not a topology primitive). */
export function yardToContract(yardObject: Yard): {
	readonly providerId: string;
	readonly runtimeId?: string;
	readonly regions: readonly string[];
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly residency: readonly string[];
	readonly isolation: readonly string[];
	readonly network: readonly string[];
	readonly componentHosts: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly bindings: readonly YardBinding[];
	readonly camps: readonly CampContract[];
} {
	return deepFreeze({
		providerId: yardObject.providerId,
		...(yardObject.runtimeId !== undefined
			? { runtimeId: yardObject.runtimeId }
			: undefined),
		regions: yardObject.regions,
		require: yardObject.require,
		prefer: yardObject.prefer,
		residency: yardObject.residency,
		isolation: yardObject.isolation,
		network: yardObject.network,
		componentHosts: yardObject.componentHosts,
		labels: yardObject.labels,
		properties: yardObject.properties,
		// Structural: selection consumes rows from the planning contract without
		// importing @hobo/yards.
		bindings: yardObject.bindings,
		camps: Object.freeze(yardObject.camps.map(campToContract)),
	});
}

/**
 * The Camp projection selection consumes — the same record `campToShape` in
 * `@hobo/camps` produces, field for field. It is re-projected here rather than
 * imported because the camps projection still ships under the banned "shape"
 * vocabulary; when the camps layer of the anti-slop initiative renames it,
 * this can collapse back to an import.
 */
export interface CampContract {
	readonly id?: string;
	readonly logicalId?: string;
	readonly env?: string;
	readonly envType?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly runtimeRequirements: readonly string[];
}

function campToContract(campObject: Camp): CampContract {
	const localId = campObject.id.includes("/")
		? campObject.id.slice(campObject.id.lastIndexOf("/") + 1)
		: campObject.id;
	return deepFreeze({
		id: localId,
		...(campObject.logicalId ? { logicalId: campObject.logicalId } : undefined),
		env: campObject.env,
		envType: campObject.envType,
		require: campObject.require,
		prefer: campObject.prefer,
		labels: campObject.labels,
		runtimeRequirements: campObject.runtimeRequirements,
	});
}

function normalizeProvider(provider: string | { readonly id: string }): string {
	if (isJsonString(provider) && provider.length > 0) return provider;
	if (
		provider &&
		isJsonObject(provider) &&
		isJsonString(provider.id) &&
		provider.id.length > 0
	) {
		return provider.id;
	}
	throw new TypeError(
		"yard requires provider (string id or { id }) — Yard is the provider selection point",
	);
}

function parseResolverDefaults(
	input: Partial<PrimitiveResolverConfig> | undefined,
): PrimitiveResolverConfig {
	if (!input) return EMPTY_RESOLVER_CONFIG;
	const pins = Object.freeze(
		(input.pins ?? []).map((p) => {
			if (!p?.slot || !p?.resolverId) {
				throw new TypeError("resolver pin requires slot and resolverId");
			}
			return Object.freeze({ slot: p.slot, resolverId: p.resolverId });
		}),
	);
	return deepFreeze({
		require: canonicalizeStringList(input.require ?? []),
		prefer: canonicalizeStringList(input.prefer ?? []),
		pins,
		properties: canonicalizeProperties(input.properties ?? {}),
		labels: canonicalizeLabels(input.labels ?? {}),
	});
}
