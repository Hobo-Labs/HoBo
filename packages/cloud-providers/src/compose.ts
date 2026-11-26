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

export interface CatalogRow {
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly properties?: NonNullable<YardConfig["properties"]>;
}

export interface YardSpecLike {
	readonly provider: string;
	readonly regions: readonly string[];
	readonly bindings: readonly CatalogRow[];
}

export interface ComposedYardOptions
	extends Omit<YardConfig, "provider" | "bindings"> {
	readonly name?: string;
}

export function regionOption(regions: readonly string[] | undefined): {
	readonly regions?: readonly string[];
} {
	return regions === undefined ? {} : { regions };
}

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
