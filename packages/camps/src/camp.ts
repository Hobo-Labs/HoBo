/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- SAFETY: this compatibility parser preserves legacy Camp JSON at the package boundary; its runtime checks and assertions are the existing contract. */
import { type CampTier, isCampTier } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import {
	type Camp,
	type CampConfig,
	type CampShape,
	EMPTY_RESOLVER_CONFIG,
	type JsonValue,
	type PrimitiveResolverConfig,
	type ProviderSelection,
	type ResolverPin,
	type ResourceMappingRule,
	TOPOLOGY_CONTRACT_VERSION,
} from "./types.js";

// public-contract: stable error code for a Camp attempting to select a provider.
export const CAMP_MIGRATION_CODE = "camp-provider-selection-forbidden" as const;
// public-contract: stable error code for a Camp attempting to own a Bindle.
export const CAMP_BINDLE_OWNERSHIP_FORBIDDEN =
	"camp-bindle-ownership-forbidden" as const;

/**
 * Author a provider-neutral Camp. Camps do not own Bindles and do not select
 * cloud providers — those belong on Yard attachment / Bindle deployment requests.
 */
export function camp(name: string, config: CampConfig = {}): Camp {
	requireName("camp name", name);
	if (!isPlainObject(config)) {
		throw new TypeError("camp config must be an object");
	}
	if (config.logicalId !== undefined && !validLogicalId(config.logicalId))
		throw new TypeError("camp logicalId must be a non-empty stable identity");

	if (config.bindle !== undefined) {
		throw Object.assign(
			new Error(
				"Camp must not own a Bindle. Attach the Bindle via a deployment request to a Yard/Camp.",
			),
			{
				code: CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
				remediation:
					"Use camp(name, { envType, require, prefer, labels }) and deploy(bindle, { yard, camp }).",
			},
		);
	}

	if (
		config.defaultProvider !== undefined ||
		config.tiers !== undefined ||
		config.bindings !== undefined
	) {
		throw Object.assign(
			new Error(
				"Camp must not select a cloud provider. Provider selection belongs on a Yard.",
			),
			{
				code: CAMP_MIGRATION_CODE,
				remediation:
					"Declare yard(name, { provider, camps: [camp(...)] }) and map resources within that provider.",
			},
		);
	}

	const env = name.includes("/")
		? must(name.split("/").pop(), "name.split('/').pop()")
		: name;
	const id = sanitizeCampId(env);
	const envType: string =
		typeof config.envType === "string" && config.envType.length > 0
			? config.envType
			: inferEnvType(env);
	// Stated, never inferred. envType is inferred from the Camp's name for
	// backwards compatibility, but repeating that trick for tier would make a
	// Camp called "data-migration" silently a data-tier segment.
	if (config.tier !== undefined && !isCampTier(config.tier as string)) {
		throw Object.assign(
			new Error(`camp tier ${JSON.stringify(config.tier)} is not a named tier`),
			{
				code: "CAMP_TIER_UNKNOWN",
				remediation:
					"Use a value from CAMP_TIERS (edge, app, data, untrusted, ops), or omit tier for a Camp that segments on some other axis.",
			},
		);
	}
	const tier = config.tier as CampTier | undefined;

	const require = canonicalizeStringList(
		Array.isArray(config.require) ? config.require : [],
	);
	const prefer = canonicalizeStringList(
		Array.isArray(config.prefer) ? config.prefer : [],
	);
	const labels = canonicalizeLabels(
		(config.labels ?? {}) as Readonly<Record<string, string>>,
	);
	const resolverConfig = parseResolverConfig(
		config.resolverConfig as Partial<PrimitiveResolverConfig> | undefined,
	);
	const resourceMappings = parseResourceMappings(
		Array.isArray(config.resourceMappings) ? config.resourceMappings : [],
	);
	const runtimeRequirements = canonicalizeStringList(
		Array.isArray(config.runtimeRequirements)
			? config.runtimeRequirements
			: config.runtime
				? [runtimeRequirementFromDescriptor(config.runtime)]
				: [],
	);

	const result: Camp = {
		kind: "camp",
		contract: TOPOLOGY_CONTRACT_VERSION,
		id,
		name: id,
		...(typeof config.logicalId === "string"
			? { logicalId: config.logicalId }
			: {}),
		env,
		envType,
		...(tier !== undefined ? { tier } : {}),
		require,
		prefer,
		labels,
		resolverConfig,
		resourceMappings,
		runtimeRequirements,
	};
	return deepFreeze(result);
}

/**
 * Attach a Camp into a Yard: derive provider from this Yard and retain the
 * logical identity and provider-neutral declaration across later moves.
 */
export function attachCampToYard(
	campObject: Camp,
	options: {
		readonly yardId: string;
		readonly providerId: string;
		readonly resolverConfig?: Partial<PrimitiveResolverConfig>;
		readonly resourceMappings?: readonly ResourceMappingRule[];
	},
): Camp {
	if (campObject?.kind !== "camp") {
		throw new TypeError("attachCampToYard expects a Camp object");
	}
	requireName("yard id", options.yardId);
	requireName("provider id", options.providerId);
	if (
		campObject.logicalId !== undefined &&
		!validLogicalId(campObject.logicalId)
	)
		throw new TypeError("camp logicalId must be a non-empty stable identity");
	const origin = campObject.enclosingYardId;
	if (
		campObject.derivedProviderId !== undefined &&
		(!origin ||
			(origin === options.yardId &&
				campObject.derivedProviderId !== options.providerId))
	) {
		throw Object.assign(
			new Error(
				`Camp provider ${campObject.derivedProviderId} disagrees with Yard provider ${options.providerId}`,
			),
			{ code: CAMP_MIGRATION_CODE },
		);
	}
	if (
		origin &&
		(!campObject.derivedProviderId ||
			!campObject.placementDeclaration ||
			!campObject.id.startsWith(`${origin}/`) ||
			campObject.id.slice(origin.length + 1).includes("/") ||
			!campObject.id.slice(origin.length + 1) ||
			!campObject.logicalId)
	)
		throw new Error(
			"Camp placement does not retain a valid provider-neutral declaration",
		);
	const localId = origin
		? campObject.id.slice(origin.length + 1)
		: campObject.id;
	const declaration = campObject.placementDeclaration ?? {
		resolverConfig: campObject.resolverConfig,
		resourceMappings: campObject.resourceMappings,
	};
	const moving = origin !== undefined && origin !== options.yardId;
	const mergedResolvers = mergeResolverConfig(
		moving ? declaration.resolverConfig : campObject.resolverConfig,
		parseResolverConfig(options.resolverConfig),
	);
	const mappings =
		options.resourceMappings !== undefined
			? parseResourceMappings(options.resourceMappings)
			: moving
				? declaration.resourceMappings
				: campObject.resourceMappings;

	return deepFreeze({
		...campObject,
		id: `${options.yardId}/${localId}`,
		name: `${options.yardId}/${localId}`,
		// The first placement's existing CD identity must remain addressable by
		// its journal after an upgrade. It is an opaque id, never a constraint
		// on the Yard to which the Camp may subsequently move.
		logicalId:
			campObject.logicalId ?? `${options.yardId}/${options.yardId}/${localId}`,
		placementDeclaration: declaration,
		derivedProviderId: options.providerId,
		enclosingYardId: options.yardId,
		resolverConfig: mergedResolvers,
		resourceMappings: mappings,
	});
}

/**
 * Compatibility: accept legacy provider-bearing mappings only when every
 * provider ID equals the enclosing Yard provider; strip provider IDs.
 */
export function parseLegacyCampMappings(
	input: {
		readonly defaultProvider?: ProviderSelection;
		readonly tiers?: Readonly<Record<string, ProviderSelection>>;
		readonly bindings?: Readonly<Record<string, ProviderSelection>>;
	},
	yardProviderId: string,
): {
	readonly resourceMappings: readonly ResourceMappingRule[];
	readonly deprecation: string;
} {
	const selections: ProviderSelection[] = [];
	if (input.defaultProvider) selections.push(input.defaultProvider);
	for (const s of Object.values(input.tiers ?? {})) selections.push(s);
	for (const s of Object.values(input.bindings ?? {})) selections.push(s);
	for (const s of selections) {
		if (s.providerId !== yardProviderId) {
			throw Object.assign(
				new Error(
					`legacy camp mapping provider ${s.providerId} != yard provider ${yardProviderId}`,
				),
				{ code: CAMP_MIGRATION_CODE },
			);
		}
	}
	const resourceMappings: ResourceMappingRule[] = [];
	for (const [key, sel] of Object.entries(input.bindings ?? {})) {
		const rule: ResourceMappingRule = {
			selector: { resourceName: key },
			require: [],
			prefer: [],
			properties: asJsonProperties(sel.options),
			...(sel.selector ? { resolverId: sel.selector } : {}),
		};
		resourceMappings.push(rule);
	}
	for (const [key, sel] of Object.entries(input.tiers ?? {})) {
		const rule: ResourceMappingRule = {
			selector: { resourceKind: key },
			require: [],
			prefer: [],
			properties: asJsonProperties(sel.options),
			...(sel.selector ? { resolverId: sel.selector } : {}),
		};
		resourceMappings.push(rule);
	}
	if (input.defaultProvider?.selector) {
		resourceMappings.push({
			selector: {},
			resolverId: input.defaultProvider.selector,
			require: [],
			prefer: [],
			properties: asJsonProperties(input.defaultProvider.options),
		});
	}
	return {
		resourceMappings: Object.freeze(resourceMappings),
		deprecation:
			"legacy camp provider mappings accepted only when equal to yard provider; stripped from canonical camp",
	};
}

export function campToShape(campObject: Camp): CampShape {
	const localId = campObject.id.includes("/")
		? must(campObject.id.split("/").pop(), "campObject.id.split('/').pop()")
		: campObject.id;
	const shape: CampShape = {
		id: localId,
		...(campObject.logicalId ? { logicalId: campObject.logicalId } : {}),
		env: campObject.env,
		envType: campObject.envType,
		require: campObject.require,
		prefer: campObject.prefer,
		labels: campObject.labels,
		runtimeRequirements: campObject.runtimeRequirements,
	};
	return deepFreeze(shape);
}

export function withResolvers(
	campObject: Camp,
	pins: Readonly<Record<string, string>>,
): Camp {
	if (campObject?.kind !== "camp") {
		throw new TypeError("withResolvers expects a Camp object");
	}
	const nextPins: ResolverPin[] = [
		...campObject.resolverConfig.pins,
		...Object.entries(pins).map(([slot, resolverId]) => ({
			slot,
			resolverId,
		})),
	];
	const slots = new Set<string>();
	for (const pin of nextPins) {
		if (slots.has(pin.slot)) {
			throw new Error(`duplicate resolver pin slot: ${pin.slot}`);
		}
		slots.add(pin.slot);
	}
	return deepFreeze({
		...campObject,
		resolverConfig: {
			...campObject.resolverConfig,
			pins: Object.freeze(nextPins),
		},
	});
}

function parseResolverConfig(
	input: Partial<PrimitiveResolverConfig> | undefined,
): PrimitiveResolverConfig {
	if (input === undefined) return EMPTY_RESOLVER_CONFIG;
	const pins = Object.freeze(
		(input.pins ?? []).map((p) => {
			if (!p?.slot || !p?.resolverId) {
				throw new TypeError("resolver pin requires slot and resolverId");
			}
			return Object.freeze({ slot: p.slot, resolverId: p.resolverId });
		}),
	);
	const slots = new Set<string>();
	for (const pin of pins) {
		if (slots.has(pin.slot)) {
			throw new Error(`duplicate resolver pin slot: ${pin.slot}`);
		}
		slots.add(pin.slot);
	}
	return deepFreeze({
		require: canonicalizeStringList(input.require ?? []),
		prefer: canonicalizeStringList(input.prefer ?? []),
		pins,
		properties: canonicalizeProperties(input.properties ?? {}),
		labels: canonicalizeLabels(input.labels ?? {}),
	});
}

function parseResourceMappings(
	rules: readonly ResourceMappingRule[],
): readonly ResourceMappingRule[] {
	return Object.freeze(
		rules.map((rule) => {
			if (!isPlainObject(rule) || !isPlainObject(rule.selector)) {
				throw new TypeError("resource mapping requires selector object");
			}
			// Reject provider field if present on legacy payloads.
			if ("provider" in rule || "providerId" in rule) {
				throw Object.assign(
					new Error(
						"ResourceMappingRule must not include provider; Yard fixes provider",
					),
					{ code: CAMP_MIGRATION_CODE },
				);
			}
			return Object.freeze({
				selector: Object.freeze({ ...rule.selector }),
				...(rule.definitionId !== undefined
					? { definitionId: rule.definitionId }
					: {}),
				...(rule.resolverId !== undefined
					? { resolverId: rule.resolverId }
					: {}),
				...(rule.className !== undefined ? { className: rule.className } : {}),
				require: canonicalizeStringList(rule.require ?? []),
				prefer: canonicalizeStringList(rule.prefer ?? []),
				properties: canonicalizeProperties(rule.properties ?? {}),
			});
		}),
	);
}

function mergeResolverConfig(
	base: PrimitiveResolverConfig,
	overlay: PrimitiveResolverConfig,
): PrimitiveResolverConfig {
	const pinMap = new Map<string, string>();
	for (const p of base.pins) pinMap.set(p.slot, p.resolverId);
	for (const p of overlay.pins) pinMap.set(p.slot, p.resolverId);
	return deepFreeze({
		require: canonicalizeStringList([...base.require, ...overlay.require]),
		prefer: canonicalizeStringList([...base.prefer, ...overlay.prefer]),
		pins: Object.freeze(
			[...pinMap.entries()].map(([slot, resolverId]) =>
				Object.freeze({ slot, resolverId }),
			),
		),
		properties: canonicalizeProperties({
			...base.properties,
			...overlay.properties,
		}),
		labels: canonicalizeLabels({ ...base.labels, ...overlay.labels }),
	});
}

function runtimeRequirementFromDescriptor(runtime: unknown): string {
	if (typeof runtime === "string") return runtime;
	if (isPlainObject(runtime) && typeof runtime.id === "string") {
		return runtime.id;
	}
	return "runtime";
}

function asJsonProperties(
	options: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
	const out: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries(options ?? {})) {
		out[k] = toJsonValue(v);
	}
	return Object.freeze(out);
}

function toJsonValue(value: unknown): JsonValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return Object.freeze(value.map(toJsonValue));
	}
	if (isPlainObject(value)) {
		return canonicalizeProperties(value as Record<string, unknown>);
	}
	throw new TypeError("resolver/resource properties must be JSON-safe");
}

function canonicalizeProperties(
	input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
	const keys = Object.keys(input).sort();
	const out: Record<string, JsonValue> = {};
	for (const key of keys) {
		// `resolverId` is a first-class field on a mapping rule, not a property,
		// so it is dropped rather than refused — a caller that spelled it as a
		// property gets the field it meant, from `rule.resolverId`.
		if (key === "resolverId") continue;
		// Every other key this pattern names is a provider account identifier:
		// `subscriptionId` and `resourceGroup` are Azure, `projectId` is GCP,
		// `accountId` is AWS/Cloudflare. Allowing one into a Camp's properties
		// is exactly the leak this module exists to prevent — a Camp that names
		// an account is no longer placeable on any other provider.
		//
		// The previous shape tested this pattern and then acted only on
		// `provider`/`providerId`, so the four account identifiers were listed
		// as forbidden and silently accepted. `@hobo/bindles` refuses the same
		// key set with the same pattern (`assertAnnotationAllowed`), so the
		// Bindle authoring surface was provider-neutral and the Camp one was not.
		if (
			/^(provider|providerId|subscriptionId|accountId|projectId|resourceGroup)$/i.test(
				key,
			)
		) {
			throw Object.assign(
				new Error(`provider-specific property key forbidden: ${key}`),
				{ code: CAMP_MIGRATION_CODE },
			);
		}
		out[key] = toJsonValue(input[key]);
	}
	return Object.freeze(out);
}

function canonicalizeStringList(values: readonly string[]): readonly string[] {
	return Object.freeze(
		[
			...new Set(values.filter((v) => typeof v === "string" && v.length > 0)),
		].sort(),
	);
}

function canonicalizeLabels(
	labels: Readonly<Record<string, string>> | Record<string, string>,
): Readonly<Record<string, string>> {
	const source = labels ?? {};
	const keys = Object.keys(source).sort();
	const out: Record<string, string> = {};
	for (const key of keys) {
		const value = source[key];
		if (typeof value !== "string") {
			throw new TypeError(`label ${key} must be a string`);
		}
		if (/^(provider|providerId|resolverId)$/i.test(key)) {
			throw Object.assign(
				new Error(`provider-specific label forbidden: ${key}`),
				{ code: CAMP_MIGRATION_CODE },
			);
		}
		out[key] = value;
	}
	return Object.freeze(out);
}

function sanitizeCampId(env: string): string {
	requireName("camp env", env);
	// Strip legacy -<provider> suffix display convention when present.
	return (
		env
			.replace(
				/-(local|aws|azure|gcp|cloudflare|oci|wasm-sandbox)$/i,
				(match, _provider) => {
					// Keep as-is if the whole name is just the provider (unlikely).
					if (match.length === env.length) return env;
					return "";
				},
			)
			.replace(/-+$/g, "") || env
	);
}

function inferEnvType(env: string): string {
	if (/^(prod|production)$/i.test(env)) return "production";
	if (/^staging$/i.test(env)) return "staging";
	if (/^(preview|pr|ephemeral)$/i.test(env)) return "ephemeral";
	if (/^(dev|development|local)$/i.test(env)) return "development";
	return env;
}

function requireName(label: string, value: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

function validLogicalId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		value === value.trim() &&
		!Array.from(value).some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as object)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

export { providerSelection } from "./provider-selection.js";
