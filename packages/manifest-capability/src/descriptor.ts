import {
	type BindlePrimitive,
	type ParsedProfileId,
	type ProfileId,
	parseProfileId,
} from "./ids.js";

export type ProfileMaturity = "stable" | "preview" | "experimental";

// domain-view: the wire form (hobo.manifest.capability.v1.EvidenceSourceRef in
export type EvidenceSourceRef = {
	readonly url: string;
	readonly checkedAt: string;
	readonly note?: string;
};

// domain-view: valueKind is a closed five-member union here and a plain
export type FeatureDescriptor = {
	readonly key: string;
	readonly description: string;
	readonly valueKind:
		| "boolean"
		| "enum"
		| "integer"
		| "semver-range"
		| "string-set";
	readonly enumValues?: readonly string[];
};

// domain-view: deliberately NOT the same type as FeatureDescriptor despite the
export type GuaranteeDescriptor = {
	readonly key: string;
	readonly description: string;
	readonly valueKind: "boolean" | "enum" | "integer";
	readonly enumValues?: readonly string[];
};

// domain-view: schemaVersion is a pinned literal type and primitive is the
export type CapabilityProfileDescriptor = {
	readonly schemaVersion: "hobo.capability-profile/v1";
	readonly id: string;
	readonly primitive: BindlePrimitive;
	readonly displayName: string;
	readonly description: string;
	readonly refines: readonly string[];
	readonly conflictsWith?: readonly string[];
	readonly requires?: readonly string[];
	readonly requirementSchemaRef: string;
	readonly conformanceSuiteRef: string;
	readonly features: readonly FeatureDescriptor[];
	readonly guarantees: readonly GuaranteeDescriptor[];
	readonly maturity: ProfileMaturity;
	readonly sourceRefs: readonly EvidenceSourceRef[];
};

export type ParsedCapabilityProfile = Omit<
	CapabilityProfileDescriptor,
	"id" | "refines" | "conflictsWith" | "requires"
> & {
	readonly id: ProfileId;
	readonly parsedId: ParsedProfileId;
	readonly refines: readonly ProfileId[];
	readonly conflictsWith: readonly ProfileId[];
	readonly requires: readonly ProfileId[];
};

export class CapabilityProfileError extends Error {
	readonly code:
		| "INVALID_CAPABILITY_PROFILE"
		| "PROFILE_REFINEMENT_CYCLE"
		| "UNSUPPORTED_PROFILE_VERSION"
		| "UNKNOWN_PROFILE";
	readonly profileId?: string;

	constructor(
		code:
			| "INVALID_CAPABILITY_PROFILE"
			| "PROFILE_REFINEMENT_CYCLE"
			| "UNSUPPORTED_PROFILE_VERSION"
			| "UNKNOWN_PROFILE",
		message: string,
		profileId?: string,
	) {
		super(message);
		this.name = "CapabilityProfileError";
		this.code = code;
		if (profileId !== undefined) this.profileId = profileId;
	}
}

function parseRefList(
	values: readonly string[] | undefined,
	descriptorId: string,
	field: string,
): readonly ProfileId[] {
	if (values === undefined) return [];
	const seen = new Set<string>();
	const parsed: ProfileId[] = [];
	for (const value of values) {
		const ref = parseProfileId(value);
		if (seen.has(ref.id)) {
			throw new CapabilityProfileError(
				"INVALID_CAPABILITY_PROFILE",
				`${descriptorId}.${field} lists ${ref.id} more than once`,
				descriptorId,
			);
		}
		seen.add(ref.id);
		parsed.push(ref.id);
	}
	return [...parsed].sort((a, b) => a.localeCompare(b));
}

export function parseCapabilityProfile(
	descriptor: CapabilityProfileDescriptor,
): ParsedCapabilityProfile {
	if (descriptor.schemaVersion !== "hobo.capability-profile/v1") {
		throw new CapabilityProfileError(
			"UNSUPPORTED_PROFILE_VERSION",
			`unsupported capability profile schemaVersion ${String(descriptor.schemaVersion)}`,
			descriptor.id,
		);
	}
	const parsedId = parseProfileId(descriptor.id);
	if (parsedId.primitive !== descriptor.primitive) {
		throw new CapabilityProfileError(
			"INVALID_CAPABILITY_PROFILE",
			`${descriptor.id} declares primitive ${descriptor.primitive} but its id resolves to ${parsedId.primitive}`,
			descriptor.id,
		);
	}
	if (descriptor.sourceRefs.length === 0) {
		throw new CapabilityProfileError(
			"INVALID_CAPABILITY_PROFILE",
			`${descriptor.id} must cite at least one evidence source`,
			descriptor.id,
		);
	}
	for (const source of descriptor.sourceRefs) {
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(source.checkedAt)) {
			throw new CapabilityProfileError(
				"INVALID_CAPABILITY_PROFILE",
				`${descriptor.id} source ${source.url} needs an ISO date checkedAt`,
				descriptor.id,
			);
		}
	}
	const featureKeys = new Set<string>();
	for (const feature of descriptor.features) {
		if (featureKeys.has(feature.key)) {
			throw new CapabilityProfileError(
				"INVALID_CAPABILITY_PROFILE",
				`${descriptor.id} declares duplicate feature ${feature.key}`,
				descriptor.id,
			);
		}
		featureKeys.add(feature.key);
	}
	const guaranteeKeys = new Set<string>();
	for (const guarantee of descriptor.guarantees) {
		if (guaranteeKeys.has(guarantee.key)) {
			throw new CapabilityProfileError(
				"INVALID_CAPABILITY_PROFILE",
				`${descriptor.id} declares duplicate guarantee ${guarantee.key}`,
				descriptor.id,
			);
		}
		guaranteeKeys.add(guarantee.key);
	}

	const refines = parseRefList(descriptor.refines, descriptor.id, "refines");
	if (refines.includes(parsedId.id)) {
		throw new CapabilityProfileError(
			"PROFILE_REFINEMENT_CYCLE",
			`${descriptor.id} refines itself`,
			descriptor.id,
		);
	}

	return {
		schemaVersion: descriptor.schemaVersion,
		id: parsedId.id,
		parsedId,
		primitive: descriptor.primitive,
		displayName: descriptor.displayName,
		description: descriptor.description,
		refines,
		conflictsWith: parseRefList(
			descriptor.conflictsWith,
			descriptor.id,
			"conflictsWith",
		),
		requires: parseRefList(descriptor.requires, descriptor.id, "requires"),
		requirementSchemaRef: descriptor.requirementSchemaRef,
		conformanceSuiteRef: descriptor.conformanceSuiteRef,
		features: descriptor.features,
		guarantees: descriptor.guarantees,
		maturity: descriptor.maturity,
		sourceRefs: descriptor.sourceRefs,
	};
}
