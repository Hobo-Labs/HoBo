/**
 * The one place a provider's allocatable catalog becomes a real `Yard`.
 *
 * Why this package exists at all: a provider package is a layer-2 adapter and
 * may import `@hobo/core` and nothing else HoBo, while `yard()` lives in
 * `@hobo/yards` at layer 3. So a provider can only publish its catalog as
 * *data* — `awsYardSpec()`, `azureYardSpec()`, and friends return plain rows,
 * not a `Yard`. Somebody above both has to do the parse, and doing it ad hoc at
 * every call site is how five slightly different spellings of "the default AWS
 * Yard" get into a codebase. This module is that somebody.
 *
 * What it deliberately does not do: decide anything. `composeYard` passes the
 * catalog through to `yard()` untouched, so the canonical set, the duplicate
 * rejection, and the credential screening are all still `@hobo/yards`'s
 * refusals with `@hobo/yards`'s error codes. If this module started filtering
 * rows it would become a second, unversioned selection point — exactly the
 * decision ADR-0157 reserves for resolution time.
 *
 * Determinism: no clock, no randomness, no environment reads. Two calls with
 * equal options produce deep-equal Yards.
 */
import { type Yard, type YardConfig, yard } from "@hobo/yards";

/**
 * The row shape every provider's `*YardSpec()` emits. Structurally identical to
 * `YardBindingInput`, restated here so this module does not force the provider
 * packages to depend on layer 3 just to name their own return type.
 */
export interface CatalogRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties?: NonNullable<YardConfig["properties"]>;
}

/** What a provider package publishes: a provider id, regions, and the catalog. */
export interface YardSpecLike {
	readonly provider: string;
	readonly regions: readonly string[];
	readonly bindings: readonly CatalogRow[];
}

/**
 * Everything `yard()` accepts except the two fields the provider's catalog
 * supplies — `provider` (a Yard is the single provider-selection point, and the
 * catalog already names it) and `bindings` (the catalog *is* the rows). `name`
 * is optional because each provider module carries a sensible default.
 *
 * `regions` stays open: the catalog's regions are the provider's published set,
 * and an operator narrowing a Yard to the regions they actually run in is a
 * residency decision, not a catalog edit.
 */
export interface ComposedYardOptions
	extends Omit<YardConfig, "provider" | "bindings"> {
	readonly name?: string;
}

/**
 * Build the `{ regions }` argument for a provider's `*YardSpec()` without
 * spelling `regions: undefined`. The repo compiles with
 * `exactOptionalPropertyTypes`, under which an explicit `undefined` is a
 * different thing from an absent key — and the providers mean "absent" to say
 * "keep your published regions".
 */
export function regionOption(regions: readonly string[] | undefined): {
	readonly regions?: readonly string[];
} {
	return regions === undefined ? {} : { regions };
}

/**
 * Parse a provider catalog into a `Yard`. `options.regions` narrows the
 * provider's published regions when supplied; omitting it keeps them all.
 */
export function composeYard(
	defaultName: string,
	spec: YardSpecLike,
	options: ComposedYardOptions = {},
): Yard {
	const { name, regions, ...rest } = options;
	return yard(name ?? defaultName, {
		...rest,
		provider: spec.provider,
		regions: regions ?? spec.regions,
		bindings: spec.bindings,
	});
}
