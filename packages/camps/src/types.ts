// public-contract: version tag for the topology object model shared across bindle/camp/yard parsing.
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-shape-in-symbol-names, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these are the established legacy provider-selection and public CampShape compatibility contracts. */
export const TOPOLOGY_CONTRACT_VERSION = "hobo.topology-objects/v1" as const;

/** Provider-neutral JSON value for resolver/resource config (no secrets). */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| Readonly<{ readonly [key: string]: JsonValue }>;

/**
 * @deprecated Legacy provider selection used only by compatibility parsers.
 * Provider ownership lives on Yard; camps no longer author provider IDs.
 */
// Deliberately richer than the wire form: retained so legacy camp files stay
// parseable; generated topology_camp_pb.ts ProviderSelection is the wire type.
// domain-view: legacy compatibility-parser view; permanent by design.
export interface ProviderSelection {
	readonly kind: "provider-selection";
	readonly providerId: string;
	readonly selector: string;
	readonly options: Readonly<Record<string, unknown>>;
}

export interface ResolverPin {
	readonly slot: string;
	readonly resolverId: string;
}

export interface PrimitiveResolverConfig {
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly pins: readonly ResolverPin[];
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly labels: Readonly<Record<string, string>>;
}

export interface ResourceSelector {
	readonly resourceKind?: string;
	readonly resourceName?: string;
	readonly portRef?: string;
	readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Resource mapping selects classes/resolvers *within* the enclosing Yard provider.
 * No provider field — Yard already fixes provider.
 */
export interface ResourceMappingRule {
	readonly selector: ResourceSelector;
	readonly definitionId?: string;
	readonly resolverId?: string;
	readonly className?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly properties: Readonly<Record<string, JsonValue>>;
}

/**
 * Provider-neutral Camp shape. A Camp does **not** own a Bindle and does **not**
 * choose a cloud provider. Provider is inherited from the enclosing Yard at
 * placement. Its logical identity survives a move; the Yard-scoped `id` names
 * one physical placement.
 */
export interface Camp {
	readonly kind: "camp";
	readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
	/** Camp local id (env name form); full id is yard-scoped at placement. */
	readonly id: string;
	readonly name: string;
	readonly env: string;
	readonly envType: string;
	/**
	 * Which segment of the workload this Camp is, when it is one of the named
	 * tiers. Optional because a Camp predates the vocabulary and because a
	 * workload may segment on an axis the standard tiers do not name; absent
	 * means "untiered", never "app".
	 */
	readonly tier?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly resolverConfig: PrimitiveResolverConfig;
	readonly resourceMappings: readonly ResourceMappingRule[];
	/** Optional substrate/runtime requirements (provider-neutral). */
	readonly runtimeRequirements: readonly string[];
	/**
	 * Derived only when camp is attached to a Yard for evidence/snapshots.
	 * Never an authored override that differs from the Yard.
	 */
	readonly derivedProviderId?: string;
	readonly enclosingYardId?: string;
	/** Stable logical identity across Yard placements. The placement's `id`
	 * remains Yard-scoped; this identifier names the same Camp after a move. */
	readonly logicalId?: string;
	/** Provider-neutral declaration retained so moving cannot carry source Yard
	 * resolver overrides into the destination. */
	readonly placementDeclaration?: {
		readonly resolverConfig: PrimitiveResolverConfig;
		readonly resourceMappings: readonly ResourceMappingRule[];
	};
}

export interface CampConfig {
	/** Optional stable identity when a Camp is independently declared in
	 * multiple Yards. Otherwise the first placement assigns one. */
	readonly logicalId?: string;
	readonly envType?: string;
	/** One of `CAMP_TIERS`; stated, never inferred from the Camp's name. */
	readonly tier?: string;
	readonly require?: readonly string[];
	readonly prefer?: readonly string[];
	readonly labels?: Readonly<Record<string, string>>;
	readonly resolverConfig?: Partial<PrimitiveResolverConfig>;
	readonly resourceMappings?: readonly ResourceMappingRule[];
	readonly runtimeRequirements?: readonly string[];
	/**
	 * @deprecated Camps no longer own Bindles. Rejected at parse with migration error.
	 */
	readonly bindle?: unknown;
	/**
	 * @deprecated Provider selection belongs on Yard. Rejected unless used via
	 * legacy attach helper with an enclosing Yard.
	 */
	readonly defaultProvider?: ProviderSelection;
	/** @deprecated */
	readonly tiers?: Readonly<Record<string, ProviderSelection>>;
	/** @deprecated */
	readonly bindings?: Readonly<Record<string, ProviderSelection>>;
	/** @deprecated runtime backends are Camp substrate requirements, not owned providers */
	readonly runtime?: unknown;
}

export interface CampShape {
	readonly id?: string;
	readonly logicalId?: string;
	readonly env?: string;
	readonly envType?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly runtimeRequirements: readonly string[];
}

export const EMPTY_RESOLVER_CONFIG: PrimitiveResolverConfig = Object.freeze({
	require: Object.freeze([] as string[]),
	prefer: Object.freeze([] as string[]),
	pins: Object.freeze([] as ResolverPin[]),
	properties: Object.freeze({}),
	labels: Object.freeze({}),
});
