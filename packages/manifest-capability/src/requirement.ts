/**
 * Capability requirements as declared by a Bindle primitive.
 *
 * A requirement never names a provider or a product. That distinction is what
 * keeps Bindles portable: `postgres.database({ version: ">=16" })` is a
 * semantic ask, not a Neon pin.
 */
import {
	type BindleRuntime,
	isBindleRuntime,
	type ProfileId,
	parseProfileId,
	type RealizationKind,
} from "./ids.js";

export class CapabilityRequirementError extends Error {
	readonly code = "INVALID_CAPABILITY_REQUIREMENT" as const;

	constructor(message: string) {
		super(message);
		this.name = "CapabilityRequirementError";
	}
}

export type ProfileConstraintInput = {
	readonly profileId: string;
	/** Semver-style range over the profile major version, e.g. ">=1". */
	readonly versionRange?: string;
};

export type WeightedPreferenceInput = ProfileConstraintInput & {
	/** Integer weight; higher means stronger preference. Ranking only. */
	readonly weight: number;
};

export type StructuredFeatureRequirementInput = {
	readonly key: string;
	readonly operator:
		| "equals"
		| "at-least"
		| "at-most"
		| "one-of"
		| "includes-all";
	readonly value: boolean | number | string | readonly string[];
	readonly necessity: "required" | "preferred";
};

export type StructuredGuaranteeRequirementInput = {
	readonly key: string;
	readonly operator: "equals" | "at-least" | "one-of";
	readonly value: boolean | number | string | readonly string[];
};

export type PortabilityRequirementInput = {
	readonly requireStandardBinding?: boolean;
	readonly requireExportProfile?: boolean;
	readonly requiredMigrationProfiles?: readonly string[];
};

export type CapabilityRequirementInput = {
	readonly requiredProfiles: readonly ProfileConstraintInput[];
	readonly preferredProfiles?: readonly WeightedPreferenceInput[];
	readonly prohibitedProfiles?: readonly ProfileConstraintInput[];
	readonly runtime?: {
		readonly required?: string;
		readonly allowed?: readonly string[];
		readonly preferred?: readonly string[];
	};
	readonly realization?: {
		readonly allowNative?: boolean;
		readonly allowPack?: boolean;
		readonly allowBridge?: boolean;
	};
	readonly features?: readonly StructuredFeatureRequirementInput[];
	readonly guarantees?: readonly StructuredGuaranteeRequirementInput[];
	readonly portability?: PortabilityRequirementInput;
	readonly trustRef?: string;
};

// the entire point of the parse boundary — it is unforgeable outside
// parseProfileId, so a raw string can never reach selection unparsed. The wire
// message carries a plain `string` because a brand has no encoding; recovering
// it is what decoding through this package is for.
// domain-view: profileId is the branded ProfileId, not a string. That brand is
export type ProfileConstraint = {
	readonly profileId: ProfileId;
	readonly versionRange: string;
};

export type WeightedPreference = ProfileConstraint & {
	readonly weight: number;
};

// than either the input or the wire message in three ways the type system
// enforces rather than documents — realization is a total
// Readonly<Record<RealizationKind, boolean>> (no absent kind), portability is
// Required<PortabilityRequirementInput> (every default already applied), and
// runtime.required/trustRef stay exact-optional so absent never decays into
// undefined. The wire message in data-models/capability_requirement.proto is
// its encoding, not its definition.
// domain-view: the parsed counterpart of CapabilityRequirementInput, and richer
export type CapabilityRequirement = {
	readonly requiredProfiles: readonly ProfileConstraint[];
	readonly preferredProfiles: readonly WeightedPreference[];
	readonly prohibitedProfiles: readonly ProfileConstraint[];
	readonly runtime: {
		readonly required?: BindleRuntime;
		readonly allowed: readonly BindleRuntime[];
		readonly preferred: readonly BindleRuntime[];
	};
	readonly realization: Readonly<Record<RealizationKind, boolean>>;
	readonly features: readonly StructuredFeatureRequirementInput[];
	readonly guarantees: readonly StructuredGuaranteeRequirementInput[];
	readonly portability: Required<PortabilityRequirementInput>;
	readonly trustRef?: string;
};

const PROVIDER_SHAPED = /(provider|vendor|account|tenant)Id$/iu;

function parseConstraint(input: ProfileConstraintInput): ProfileConstraint {
	const parsed = parseProfileId(input.profileId);
	const range = (input.versionRange ?? `>=${parsed.major}`).trim();
	if (
		!/^(?:\*|[><]=?|=|\^|~)?\s*v?\d+(?:\.\d+){0,2}$/u.test(range) &&
		range !== "*"
	) {
		throw new CapabilityRequirementError(
			`invalid version range ${JSON.stringify(range)} for ${parsed.id}`,
		);
	}
	return { profileId: parsed.id, versionRange: range };
}

function sortConstraints<T extends ProfileConstraint>(
	values: readonly T[],
): readonly T[] {
	return [...values].sort((a, b) => a.profileId.localeCompare(b.profileId));
}

function parseRuntimes(
	values: readonly string[] | undefined,
): readonly BindleRuntime[] {
	if (values === undefined) return [];
	const parsed: BindleRuntime[] = [];
	for (const value of values) {
		if (!isBindleRuntime(value)) {
			throw new CapabilityRequirementError(
				`unknown runtime model ${JSON.stringify(value)}`,
			);
		}
		if (!parsed.includes(value)) parsed.push(value);
	}
	return parsed;
}

/**
 * Parse-don't-validate boundary. The returned requirement is canonically
 * ordered so equivalent authoring order produces byte-identical decisions.
 */
export function parseCapabilityRequirement(
	input: CapabilityRequirementInput,
): CapabilityRequirement {
	for (const key of Object.keys(input)) {
		if (PROVIDER_SHAPED.test(key)) {
			throw new CapabilityRequirementError(
				`capability requirements must stay provider-neutral; remove ${key}`,
			);
		}
	}
	if (input.requiredProfiles.length === 0) {
		throw new CapabilityRequirementError(
			"a capability requirement must name at least one required profile",
		);
	}

	const required = sortConstraints(input.requiredProfiles.map(parseConstraint));
	const prohibited = sortConstraints(
		(input.prohibitedProfiles ?? []).map(parseConstraint),
	);
	for (const constraint of required) {
		if (prohibited.some((entry) => entry.profileId === constraint.profileId)) {
			throw new CapabilityRequirementError(
				`${constraint.profileId} is both required and prohibited`,
			);
		}
	}

	const preferred = [...(input.preferredProfiles ?? [])].map((entry) => {
		if (!Number.isInteger(entry.weight) || entry.weight < 0) {
			throw new CapabilityRequirementError(
				`preference weight for ${entry.profileId} must be a non-negative integer`,
			);
		}
		return { ...parseConstraint(entry), weight: entry.weight };
	});
	// Deterministic: strongest preference first, then stable by profile id.
	preferred.sort(
		(a, b) => b.weight - a.weight || a.profileId.localeCompare(b.profileId),
	);

	const requiredRuntime = input.runtime?.required;
	if (requiredRuntime !== undefined && !isBindleRuntime(requiredRuntime)) {
		throw new CapabilityRequirementError(
			`unknown required runtime ${JSON.stringify(requiredRuntime)}`,
		);
	}

	const realization = {
		native: input.realization?.allowNative ?? true,
		pack: input.realization?.allowPack ?? true,
		bridge: input.realization?.allowBridge ?? true,
	} satisfies Record<RealizationKind, boolean>;
	if (!realization.native && !realization.pack && !realization.bridge) {
		throw new CapabilityRequirementError(
			"at least one realization kind (native/pack/bridge) must be allowed",
		);
	}

	const features = [...(input.features ?? [])].sort((a, b) =>
		a.key.localeCompare(b.key),
	);
	const guarantees = [...(input.guarantees ?? [])].sort((a, b) =>
		a.key.localeCompare(b.key),
	);

	const runtime: CapabilityRequirement["runtime"] = {
		...(requiredRuntime !== undefined
			? { required: requiredRuntime as BindleRuntime }
			: {}),
		allowed: parseRuntimes(input.runtime?.allowed),
		preferred: parseRuntimes(input.runtime?.preferred),
	};

	return {
		requiredProfiles: required,
		preferredProfiles: preferred,
		prohibitedProfiles: prohibited,
		runtime,
		realization,
		features,
		guarantees,
		portability: {
			requireStandardBinding:
				input.portability?.requireStandardBinding ?? false,
			requireExportProfile: input.portability?.requireExportProfile ?? false,
			requiredMigrationProfiles: [
				...(input.portability?.requiredMigrationProfiles ?? []),
			].sort((a, b) => a.localeCompare(b)),
		},
		...(input.trustRef !== undefined ? { trustRef: input.trustRef } : {}),
	};
}
