/**
 * The wire form of the capability manifest, and the only place the schema in
 * `data-models/` is executable.
 *
 * A `.proto` nobody encodes against is documentation. These functions are the
 * mapping the tests round-trip through, so a field that the schema cannot
 * carry fails a test instead of being discovered by a consumer.
 *
 * Two rules govern everything here.
 *
 * **Decoding never re-parses.** `fromCapabilityRequirementWire` reconstructs
 * the value from the wire alone; it does not call
 * {@link parseCapabilityRequirement}. If it did, every default the parse
 * boundary applies would be re-derived on the way back, and a wire form that
 * had dropped `portability.requireExportProfile` entirely would still
 * round-trip green. The round trip has to be able to fail.
 *
 * **Presence is preserved, in both directions.** `tsconfig.base.json` sets
 * `exactOptionalPropertyTypes`, so an absent property and a property holding
 * `undefined` are different values. Optional scalars are omitted rather than
 * zeroed, and optional *lists* travel inside a {@link WireStringList} wrapper,
 * because proto3's bare `repeated` cannot tell an absent list from an empty
 * one. That distinction is not academic: the registry digest is computed with
 * `JSON.stringify`, which omits an `undefined` property and emits `[]` for an
 * empty array, so conflating them changes a digest that twelve committed
 * golden offers under `packages/recipes/test/golden/` carry.
 */
import type {
	CapabilityProfileDescriptor,
	EvidenceSourceRef,
	FeatureDescriptor,
	GuaranteeDescriptor,
	ProfileMaturity,
} from "./descriptor.js";
import type { BindleRuntime, RealizationKind } from "./ids.js";
import type {
	CapabilityRequirement,
	ProfileConstraint,
	StructuredFeatureRequirementInput,
	StructuredGuaranteeRequirementInput,
	WeightedPreference,
} from "./requirement.js";

/** Thrown when a value cannot cross the wire without losing something. */
export class CapabilityWireError extends Error {
	readonly code = "INVALID_CAPABILITY_WIRE" as const;

	constructor(message: string) {
		super(message);
		this.name = "CapabilityWireError";
	}
}

/**
 * The presence wrapper for a repeated field.
 *
 * `hobo.manifest.capability.v1.StringList`. Exists solely so `undefined` and
 * `[]` stay distinguishable across the wire.
 */
export type WireStringList = { readonly values: readonly string[] };

export type WireProfileConstraint = {
	readonly profile_id: string;
	readonly version_range: string;
};

export type WireWeightedPreference = WireProfileConstraint & {
	readonly weight: number;
};

export type WireRuntimeRequirement = {
	readonly required?: string;
	readonly allowed: readonly string[];
	readonly preferred: readonly string[];
};

export type WireRealizationAllowance = {
	readonly native: boolean;
	readonly pack: boolean;
	readonly bridge: boolean;
};

/**
 * The `RequirementValue` oneof, as proto3 JSON encodes it: exactly one key.
 *
 * `int_value` is a decimal string, which is the proto3 JSON mapping for
 * `int64` and also the only encoding that does not quietly lose a value
 * outside the double-precision integer range on the way through a JSON parser.
 */
export type WireRequirementValue =
	| { readonly bool_value: boolean }
	| { readonly int_value: string }
	| { readonly double_value: number }
	| { readonly string_value: string }
	| { readonly string_set_value: WireStringList };

export type WireStructuredFeatureRequirement = {
	readonly key: string;
	readonly operator: string;
	readonly value: WireRequirementValue;
	readonly necessity: string;
};

export type WireStructuredGuaranteeRequirement = {
	readonly key: string;
	readonly operator: string;
	readonly value: WireRequirementValue;
};

export type WirePortabilityRequirement = {
	readonly require_standard_binding: boolean;
	readonly require_export_profile: boolean;
	readonly required_migration_profiles: readonly string[];
};

/** `hobo.manifest.capability.v1.CapabilityRequirement`. */
export type WireCapabilityRequirement = {
	readonly required_profiles: readonly WireProfileConstraint[];
	readonly preferred_profiles: readonly WireWeightedPreference[];
	readonly prohibited_profiles: readonly WireProfileConstraint[];
	readonly runtime: WireRuntimeRequirement;
	readonly realization: WireRealizationAllowance;
	readonly features: readonly WireStructuredFeatureRequirement[];
	readonly guarantees: readonly WireStructuredGuaranteeRequirement[];
	readonly portability: WirePortabilityRequirement;
	readonly trust_ref?: string;
};

export type WireEvidenceSourceRef = {
	readonly url: string;
	readonly checked_at: string;
	readonly note?: string;
};

export type WireFeatureDescriptor = {
	readonly key: string;
	readonly description: string;
	readonly value_kind: string;
	readonly enum_values?: WireStringList;
};

export type WireGuaranteeDescriptor = WireFeatureDescriptor;

/** `hobo.manifest.capability.v1.CapabilityProfileDescriptor`. */
export type WireCapabilityProfileDescriptor = {
	readonly schema_version: string;
	readonly id: string;
	readonly primitive: string;
	readonly display_name: string;
	readonly description: string;
	readonly refines: readonly string[];
	readonly conflicts_with?: WireStringList;
	readonly requires?: WireStringList;
	readonly requirement_schema_ref: string;
	readonly conformance_suite_ref: string;
	readonly features: readonly WireFeatureDescriptor[];
	readonly guarantees: readonly WireGuaranteeDescriptor[];
	readonly maturity: string;
	readonly source_refs: readonly WireEvidenceSourceRef[];
};

/** `hobo.manifest.capability.v1.CapabilityProfileCatalog`. */
export type WireCapabilityProfileCatalog = {
	readonly schema_version: typeof CAPABILITY_PROFILE_CATALOG_SCHEMA_VERSION;
	readonly profiles: readonly WireCapabilityProfileDescriptor[];
};

// public-contract: the catalog envelope's schema identity; consumers pin it to
// detect a catalog shape change rather than a catalog content change.
export const CAPABILITY_PROFILE_CATALOG_SCHEMA_VERSION =
	"hobo.capability-profile-catalog/v1";

const FEATURE_OPERATORS = [
	"equals",
	"at-least",
	"at-most",
	"one-of",
	"includes-all",
] as const;
const GUARANTEE_OPERATORS = ["equals", "at-least", "one-of"] as const;
const NECESSITIES = ["required", "preferred"] as const;
const FEATURE_VALUE_KINDS = [
	"boolean",
	"enum",
	"integer",
	"semver-range",
	"string-set",
] as const;
const GUARANTEE_VALUE_KINDS = ["boolean", "enum", "integer"] as const;
const MATURITIES = ["stable", "preview", "experimental"] as const;

function fail(message: string): never {
	throw new CapabilityWireError(message);
}

function member<T extends string>(
	value: unknown,
	allowed: readonly T[],
	field: string,
): T {
	if (
		typeof value !== "string" ||
		!(allowed as readonly string[]).includes(value)
	) {
		fail(
			`${field} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}, received ${JSON.stringify(value)}`,
		);
	}
	return value as T;
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string") {
		fail(`${field} must be a string, received ${JSON.stringify(value)}`);
	}
	return value;
}

function flag(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		fail(`${field} must be a boolean, received ${JSON.stringify(value)}`);
	}
	return value;
}

function textList(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value)) {
		fail(`${field} must be an array, received ${JSON.stringify(value)}`);
	}
	return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${field} must be an object, received ${JSON.stringify(value)}`);
	}
	return value as Record<string, unknown>;
}

function list(value: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		fail(`${field} must be an array, received ${JSON.stringify(value)}`);
	}
	return value;
}

function stringListOf(
	values: readonly string[] | undefined,
): WireStringList | undefined {
	return values === undefined ? undefined : { values: [...values] };
}

function fromStringList(
	value: unknown,
	field: string,
): readonly string[] | undefined {
	if (value === undefined) return undefined;
	const wrapper = record(value, field);
	return textList(wrapper.values, `${field}.values`);
}

/**
 * Encode the value side of a structured predicate.
 *
 * The four TypeScript arms map to five wire arms because JavaScript has one
 * number type and protobuf does not. A non-finite number is refused rather
 * than encoded: JSON has no spelling for it, and a NaN threshold is not a
 * requirement anyone meant to write.
 */
function toWireValue(
	value: boolean | number | string | readonly string[],
	field: string,
): WireRequirementValue {
	if (typeof value === "boolean") return { bool_value: value };
	if (typeof value === "string") return { string_value: value };
	if (Array.isArray(value)) {
		return { string_set_value: { values: [...(value as readonly string[])] } };
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			fail(
				`${field} is ${String(value)}; a non-finite requirement value has no wire encoding and no meaning as a threshold`,
			);
		}
		if (Number.isSafeInteger(value)) return { int_value: String(value) };
		return { double_value: value };
	}
	return fail(
		`${field} must be a boolean, number, string, or string array, received ${JSON.stringify(value)}`,
	);
}

function fromWireValue(
	value: unknown,
	field: string,
): boolean | number | string | readonly string[] {
	const wrapper = record(value, field);
	const keys = Object.keys(wrapper);
	if (keys.length !== 1) {
		fail(
			`${field} must hold exactly one of bool_value/int_value/double_value/string_value/string_set_value, received ${keys.length} (${keys.join(", ")})`,
		);
	}
	if ("bool_value" in wrapper) {
		return flag(wrapper.bool_value, `${field}.bool_value`);
	}
	if ("string_value" in wrapper) {
		return text(wrapper.string_value, `${field}.string_value`);
	}
	if ("string_set_value" in wrapper) {
		const values = fromStringList(
			wrapper.string_set_value,
			`${field}.string_set_value`,
		);
		return values === undefined
			? fail(`${field}.string_set_value is absent`)
			: values;
	}
	if ("int_value" in wrapper) {
		const raw = text(wrapper.int_value, `${field}.int_value`);
		if (!/^-?\d+$/u.test(raw)) {
			fail(
				`${field}.int_value must be a decimal integer string (the proto3 JSON mapping for int64), received ${JSON.stringify(raw)}`,
			);
		}
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed)) {
			fail(
				`${field}.int_value ${raw} is outside the range a JavaScript number represents exactly; decoding it would silently change the threshold`,
			);
		}
		return parsed;
	}
	if ("double_value" in wrapper) {
		const raw = wrapper.double_value;
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			fail(
				`${field}.double_value must be a finite number, received ${JSON.stringify(raw)}`,
			);
		}
		return raw;
	}
	return fail(
		`${field} names no known RequirementValue arm: ${JSON.stringify(keys[0])}`,
	);
}

function toWireConstraint(value: ProfileConstraint): WireProfileConstraint {
	return { profile_id: value.profileId, version_range: value.versionRange };
}

function fromWireConstraint(value: unknown, field: string): ProfileConstraint {
	const entry = record(value, field);
	return {
		profileId: text(
			entry.profile_id,
			`${field}.profile_id`,
		) as ProfileConstraint["profileId"],
		versionRange: text(entry.version_range, `${field}.version_range`),
	};
}

/**
 * Encode a parsed capability requirement.
 *
 * Field order matches the message declaration order in
 * `data-models/capability_requirement.proto`, which is also the key order
 * {@link parseCapabilityRequirement} returns — so a decoded requirement is
 * byte-identical under `JSON.stringify`, not merely deep-equal.
 */
export function toCapabilityRequirementWire(
	value: CapabilityRequirement,
): WireCapabilityRequirement {
	return {
		required_profiles: value.requiredProfiles.map(toWireConstraint),
		preferred_profiles: value.preferredProfiles.map((entry) => ({
			...toWireConstraint(entry),
			weight: entry.weight,
		})),
		prohibited_profiles: value.prohibitedProfiles.map(toWireConstraint),
		runtime: {
			...(value.runtime.required !== undefined
				? { required: value.runtime.required }
				: {}),
			allowed: [...value.runtime.allowed],
			preferred: [...value.runtime.preferred],
		},
		realization: {
			native: value.realization.native,
			pack: value.realization.pack,
			bridge: value.realization.bridge,
		},
		features: value.features.map((entry, index) => ({
			key: entry.key,
			operator: entry.operator,
			value: toWireValue(entry.value, `features[${index}].value`),
			necessity: entry.necessity,
		})),
		guarantees: value.guarantees.map((entry, index) => ({
			key: entry.key,
			operator: entry.operator,
			value: toWireValue(entry.value, `guarantees[${index}].value`),
		})),
		portability: {
			require_standard_binding: value.portability.requireStandardBinding,
			require_export_profile: value.portability.requireExportProfile,
			required_migration_profiles: [
				...value.portability.requiredMigrationProfiles,
			],
		},
		...(value.trustRef !== undefined ? { trust_ref: value.trustRef } : {}),
	};
}

/**
 * Decode a capability requirement from its wire form.
 *
 * Deliberately does not call {@link parseCapabilityRequirement}: re-parsing
 * would re-derive every default and make a lossy encoder look lossless.
 */
export function fromCapabilityRequirementWire(
	wire: unknown,
): CapabilityRequirement {
	const root = record(wire, "CapabilityRequirement");

	const requiredProfiles = list(
		root.required_profiles,
		"required_profiles",
	).map((entry, index) =>
		fromWireConstraint(entry, `required_profiles[${index}]`),
	);
	if (requiredProfiles.length === 0) {
		fail("required_profiles must name at least one profile");
	}

	const preferredProfiles: WeightedPreference[] = list(
		root.preferred_profiles,
		"preferred_profiles",
	).map((entry, index) => {
		const field = `preferred_profiles[${index}]`;
		const parsed = fromWireConstraint(entry, field);
		const weight = record(entry, field).weight;
		if (!Number.isInteger(weight) || (weight as number) < 0) {
			fail(
				`${field}.weight must be a non-negative integer, received ${JSON.stringify(weight)}`,
			);
		}
		return { ...parsed, weight: weight as number };
	});

	const prohibitedProfiles = list(
		root.prohibited_profiles,
		"prohibited_profiles",
	).map((entry, index) =>
		fromWireConstraint(entry, `prohibited_profiles[${index}]`),
	);

	const runtimeWire = record(root.runtime, "runtime");
	const requiredRuntime = runtimeWire.required;
	const runtime: CapabilityRequirement["runtime"] = {
		...(requiredRuntime !== undefined
			? { required: text(requiredRuntime, "runtime.required") as BindleRuntime }
			: {}),
		allowed: textList(
			runtimeWire.allowed,
			"runtime.allowed",
		) as readonly BindleRuntime[],
		preferred: textList(
			runtimeWire.preferred,
			"runtime.preferred",
		) as readonly BindleRuntime[],
	};

	const realizationWire = record(root.realization, "realization");
	const realization: Readonly<Record<RealizationKind, boolean>> = {
		native: flag(realizationWire.native, "realization.native"),
		pack: flag(realizationWire.pack, "realization.pack"),
		bridge: flag(realizationWire.bridge, "realization.bridge"),
	};

	const features: StructuredFeatureRequirementInput[] = list(
		root.features,
		"features",
	).map((entry, index) => {
		const field = `features[${index}]`;
		const item = record(entry, field);
		return {
			key: text(item.key, `${field}.key`),
			operator: member(item.operator, FEATURE_OPERATORS, `${field}.operator`),
			value: fromWireValue(item.value, `${field}.value`),
			necessity: member(item.necessity, NECESSITIES, `${field}.necessity`),
		};
	});

	const guarantees: StructuredGuaranteeRequirementInput[] = list(
		root.guarantees,
		"guarantees",
	).map((entry, index) => {
		const field = `guarantees[${index}]`;
		const item = record(entry, field);
		return {
			key: text(item.key, `${field}.key`),
			operator: member(item.operator, GUARANTEE_OPERATORS, `${field}.operator`),
			value: fromWireValue(item.value, `${field}.value`),
		};
	});

	const portabilityWire = record(root.portability, "portability");
	const trustRef = root.trust_ref;

	return {
		requiredProfiles,
		preferredProfiles,
		prohibitedProfiles,
		runtime,
		realization,
		features,
		guarantees,
		portability: {
			requireStandardBinding: flag(
				portabilityWire.require_standard_binding,
				"portability.require_standard_binding",
			),
			requireExportProfile: flag(
				portabilityWire.require_export_profile,
				"portability.require_export_profile",
			),
			requiredMigrationProfiles: textList(
				portabilityWire.required_migration_profiles,
				"portability.required_migration_profiles",
			),
		},
		...(trustRef !== undefined
			? { trustRef: text(trustRef, "trust_ref") }
			: {}),
	};
}

function toWireSourceRef(value: EvidenceSourceRef): WireEvidenceSourceRef {
	return {
		url: value.url,
		checked_at: value.checkedAt,
		...(value.note !== undefined ? { note: value.note } : {}),
	};
}

function toWireFeature(value: FeatureDescriptor): WireFeatureDescriptor {
	const enumValues = stringListOf(value.enumValues);
	return {
		key: value.key,
		description: value.description,
		value_kind: value.valueKind,
		...(enumValues !== undefined ? { enum_values: enumValues } : {}),
	};
}

function toWireGuarantee(value: GuaranteeDescriptor): WireGuaranteeDescriptor {
	const enumValues = stringListOf(value.enumValues);
	return {
		key: value.key,
		description: value.description,
		value_kind: value.valueKind,
		...(enumValues !== undefined ? { enum_values: enumValues } : {}),
	};
}

/**
 * Encode a capability profile descriptor.
 *
 * Key order matches `standard-profiles.ts`'s own construction order, so a
 * decoded descriptor is byte-identical under `JSON.stringify` to the constant
 * it came from.
 */
export function toCapabilityProfileDescriptorWire(
	value: CapabilityProfileDescriptor,
): WireCapabilityProfileDescriptor {
	const conflictsWith = stringListOf(value.conflictsWith);
	const requires = stringListOf(value.requires);
	return {
		schema_version: value.schemaVersion,
		id: value.id,
		primitive: value.primitive,
		display_name: value.displayName,
		description: value.description,
		refines: [...value.refines],
		...(conflictsWith !== undefined ? { conflicts_with: conflictsWith } : {}),
		...(requires !== undefined ? { requires } : {}),
		requirement_schema_ref: value.requirementSchemaRef,
		conformance_suite_ref: value.conformanceSuiteRef,
		features: value.features.map(toWireFeature),
		guarantees: value.guarantees.map(toWireGuarantee),
		maturity: value.maturity,
		source_refs: value.sourceRefs.map(toWireSourceRef),
	};
}

/** Decode a capability profile descriptor. Never re-parses; see the module doc. */
export function fromCapabilityProfileDescriptorWire(
	wire: unknown,
): CapabilityProfileDescriptor {
	const root = record(wire, "CapabilityProfileDescriptor");
	const schemaVersion = text(root.schema_version, "schema_version");
	if (schemaVersion !== "hobo.capability-profile/v1") {
		fail(
			`schema_version must be "hobo.capability-profile/v1", received ${JSON.stringify(schemaVersion)}`,
		);
	}
	const conflictsWith = fromStringList(root.conflicts_with, "conflicts_with");
	const requires = fromStringList(root.requires, "requires");
	const sourceRefs = list(root.source_refs, "source_refs").map(
		(entry, index) => {
			const field = `source_refs[${index}]`;
			const item = record(entry, field);
			const note = item.note;
			return {
				url: text(item.url, `${field}.url`),
				checkedAt: text(item.checked_at, `${field}.checked_at`),
				...(note !== undefined ? { note: text(note, `${field}.note`) } : {}),
			};
		},
	);
	if (sourceRefs.length === 0) {
		fail(`${schemaVersion} descriptor must cite at least one evidence source`);
	}

	return {
		schemaVersion: "hobo.capability-profile/v1",
		id: text(root.id, "id"),
		primitive: member(
			root.primitive,
			[
				"web",
				"api",
				"service",
				"data",
				"kv",
				"bucket",
				"queue",
				"topic",
				"secretRef",
				"webhook",
			] as const,
			"primitive",
		),
		displayName: text(root.display_name, "display_name"),
		description: text(root.description, "description"),
		refines: textList(root.refines, "refines"),
		...(conflictsWith !== undefined ? { conflictsWith } : {}),
		...(requires !== undefined ? { requires } : {}),
		requirementSchemaRef: text(
			root.requirement_schema_ref,
			"requirement_schema_ref",
		),
		conformanceSuiteRef: text(
			root.conformance_suite_ref,
			"conformance_suite_ref",
		),
		features: list(root.features, "features").map((entry, index) => {
			const field = `features[${index}]`;
			const item = record(entry, field);
			const enumValues = fromStringList(
				item.enum_values,
				`${field}.enum_values`,
			);
			return {
				key: text(item.key, `${field}.key`),
				description: text(item.description, `${field}.description`),
				valueKind: member(
					item.value_kind,
					FEATURE_VALUE_KINDS,
					`${field}.value_kind`,
				),
				...(enumValues !== undefined ? { enumValues } : {}),
			};
		}),
		guarantees: list(root.guarantees, "guarantees").map((entry, index) => {
			const field = `guarantees[${index}]`;
			const item = record(entry, field);
			const enumValues = fromStringList(
				item.enum_values,
				`${field}.enum_values`,
			);
			return {
				key: text(item.key, `${field}.key`),
				description: text(item.description, `${field}.description`),
				valueKind: member(
					item.value_kind,
					GUARANTEE_VALUE_KINDS,
					`${field}.value_kind`,
				),
				...(enumValues !== undefined ? { enumValues } : {}),
			};
		}),
		maturity: member(root.maturity, MATURITIES, "maturity") as ProfileMaturity,
		sourceRefs,
	};
}

/** Encode the whole first-party catalog as one pinnable record. */
export function toCapabilityProfileCatalogWire(
	profiles: readonly CapabilityProfileDescriptor[],
): WireCapabilityProfileCatalog {
	return {
		schema_version: CAPABILITY_PROFILE_CATALOG_SCHEMA_VERSION,
		profiles: profiles.map(toCapabilityProfileDescriptorWire),
	};
}

/** Decode the whole first-party catalog. */
export function fromCapabilityProfileCatalogWire(
	wire: unknown,
): readonly CapabilityProfileDescriptor[] {
	const root = record(wire, "CapabilityProfileCatalog");
	const schemaVersion = text(root.schema_version, "schema_version");
	if (schemaVersion !== CAPABILITY_PROFILE_CATALOG_SCHEMA_VERSION) {
		fail(
			`schema_version must be ${JSON.stringify(CAPABILITY_PROFILE_CATALOG_SCHEMA_VERSION)}, received ${JSON.stringify(schemaVersion)}`,
		);
	}
	return list(root.profiles, "profiles").map((entry) =>
		fromCapabilityProfileDescriptorWire(entry),
	);
}
