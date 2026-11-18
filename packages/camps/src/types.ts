/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-shape-in-symbol-names, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these are the established legacy provider-selection and public CampShape compatibility contracts. */
export const TOPOLOGY_CONTRACT_VERSION = "hobo.topology-objects/v1" as const;

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

export interface ResourceMappingRule {
	readonly selector: ResourceSelector;
	readonly definitionId?: string;
	readonly resolverId?: string;
	readonly className?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly properties: Readonly<Record<string, JsonValue>>;
}

export interface Camp {
	readonly kind: "camp";
	readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
	readonly id: string;
	readonly name: string;
	readonly env: string;
	readonly envType: string;
	readonly tier?: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
	readonly resolverConfig: PrimitiveResolverConfig;
	readonly resourceMappings: readonly ResourceMappingRule[];
	readonly runtimeRequirements: readonly string[];
	readonly derivedProviderId?: string;
	readonly enclosingYardId?: string;
	readonly logicalId?: string;
	readonly placementDeclaration?: {
		readonly resolverConfig: PrimitiveResolverConfig;
		readonly resourceMappings: readonly ResourceMappingRule[];
	};
}

export interface CampConfig {
	readonly logicalId?: string;
	readonly envType?: string;
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
