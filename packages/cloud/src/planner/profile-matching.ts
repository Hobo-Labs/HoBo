import { createHash } from "node:crypto";
import {
	BINDING_UNAVAILABLE_REMEDIATION,
	type BindingResolvedEvent,
	type BindingUnavailableCode,
	type BindingUnavailableEvent,
	bindingResolved,
	bindingUnavailable,
	yardBindingRowKey,
} from "@hobo/bindings";
import type { BindleRequirements } from "@hobo/bindles";
import {
	type CapabilityProfileRegistry,
	type CapabilityRequirement,
	isBindleRuntime,
	parseCapabilityRequirement,
	type SelectionCandidate,
	type SelectionRejection,
	selectCapabilityImplementation,
	type TrustPolicy,
	tryParseProfileId,
} from "@hobo/capability-profiles";
import type { JsonBag, JsonObject, JsonValue } from "../json.js";
import type { PlanRemediation } from "../plan-types.js";
import {
	type ResourceDefinitionVNext,
	semanticsDigestInput,
	toSelectionCandidate,
} from "../registry/resource-definition-vnext.js";

export class YardBindingParameterConflictError extends Error {
	readonly code = "YARD_BINDING_PARAMETER_CONFLICT" as const;
	readonly parameter: string;
	readonly rows: readonly string[];

	constructor(parameter: string, firstRow: string, secondRow: string) {
		super(
			`yard binding rows disagree on realization parameter "${parameter}": ${firstRow} and ${secondRow}. Rows are a set with no precedence — give the parameter one value, or split the profiles.`,
		);
		this.name = "YardBindingParameterConflictError";
		this.parameter = parameter;
		this.rows = Object.freeze([firstRow, secondRow].sort());
	}
}

export function capabilityRequirementFromBindleRequirements(
	requirements: BindleRequirements,
): CapabilityRequirement | undefined {
	const required = requirements.require.filter(
		(value) => tryParseProfileId(value) !== undefined,
	);
	if (required.length === 0) return undefined;
	const preferred = requirements.prefer.filter(
		(value) => tryParseProfileId(value) !== undefined,
	);
	const runtimes = requirements.runtimes.filter((value) =>
		isBindleRuntime(value),
	);
	return parseCapabilityRequirement({
		requiredProfiles: required.map((profileId) => ({ profileId })),
		preferredProfiles: preferred.map((profileId) => ({ profileId, weight: 1 })),
		...(runtimes.length > 0 ? { runtime: { allowed: runtimes } } : undefined),
	});
}

export type YardBindingRow = {
	readonly contract?: string;
	readonly profile: string;
	readonly productId?: string;
	readonly connectivityId?: string;
	readonly require?: readonly string[];
	readonly properties?: Readonly<JsonObject>;
};

export type YardBindingContext = {
	readonly yardId: string;
	readonly providerId: string;
	readonly bindings: readonly YardBindingRow[];
};

export type YardBindingRejectionCode = Exclude<
	BindingUnavailableCode,
	"NO_COMPATIBLE_BINDING"
>;

export type YardBindingRejection = {
	readonly definitionId: string;
	readonly code: YardBindingRejectionCode;
	readonly detail: string;
};

export type ProfileMatchRejectionRecord =
	| SelectionRejection
	| YardBindingRejection;

export type ProfileMatchInput = {
	readonly resourceName: string;
	readonly requirement: CapabilityRequirement;
	readonly profiles: CapabilityProfileRegistry;
	readonly definitions: readonly ResourceDefinitionVNext[];
	readonly policy: TrustPolicy;
	readonly nowMs: number;
	readonly consumableBindingProfiles?: readonly string[];
	readonly yard?: YardBindingContext;
};

export type ProfileMatchAccepted = {
	readonly ok: true;
	readonly definition: ResourceDefinitionVNext;
	readonly ranking: readonly string[];
	readonly rejections: readonly ProfileMatchRejectionRecord[];
	readonly catalogHash: string;
	readonly tie: boolean;
	readonly appliedRows?: readonly string[];
	readonly realizationParameters?: Readonly<JsonObject>;
	readonly nonPortableRows?: readonly string[];
	readonly bindingResolved?: BindingResolvedEvent;
};

export type ProfileMatchRejected = {
	readonly ok: false;
	readonly remediation: PlanRemediation;
	readonly rejections: readonly ProfileMatchRejectionRecord[];
	readonly catalogHash: string;
	readonly bindingUnavailable?: BindingUnavailableEvent;
};

export type ProfileMatchOutcome = ProfileMatchAccepted | ProfileMatchRejected;

export function profileCatalogHash(
	definitions: readonly ResourceDefinitionVNext[],
	profiles: CapabilityProfileRegistry,
): string {
	const entries = definitions
		.map(semanticsDigestInput)
		.filter((entry): entry is JsonObject => entry !== undefined)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	const payload = JSON.stringify({
		profiles: profiles.digest,
		definitions: entries,
	});
	return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

type AttributedRejection = {
	readonly rejection: YardBindingRejection;
	readonly profile: string;
};

export function validateYardBindingOwnership(
	yard: YardBindingContext,
	definitions: readonly ResourceDefinitionVNext[],
): readonly AttributedRejection[] {
	const byProduct = new Map<string, ResourceDefinitionVNext[]>();
	for (const definition of definitions) {
		const productId = definition.semantics?.productId;
		if (productId === undefined) continue;
		const bucket = byProduct.get(productId);
		if (bucket === undefined) byProduct.set(productId, [definition]);
		else bucket.push(definition);
	}
	const rejections: AttributedRejection[] = [];
	for (const row of yard.bindings) {
		const productId = row.productId;
		if (!productId) continue;
		if (/^external(?:[.:/]|$)/iu.test(productId)) {
			rejections.push({
				profile: row.profile,
				rejection: {
					definitionId: productId,
					code: "YARD_BINDING_PROVIDER_MISMATCH",
					detail: `yard ${yard.yardId} cannot own external product placeholder ${productId}; use a provider Yard and Junction`,
				},
			});
			continue;
		}
		const matches = byProduct.get(productId);
		if (!matches?.length) {
			rejections.push({
				profile: row.profile,
				rejection: {
					definitionId: productId,
					code: "YARD_BINDING_PRODUCT_UNKNOWN",
					detail: `yard ${yard.yardId} binds ${row.profile} to product ${productId}, which no registered product declares`,
				},
			});
			continue;
		}
		for (const definition of [...matches].sort((a, b) =>
			a.id.localeCompare(b.id),
		)) {
			if (definition.providerId !== yard.providerId)
				rejections.push({
					profile: row.profile,
					rejection: {
						definitionId: definition.id,
						code: "YARD_BINDING_PROVIDER_MISMATCH",
						detail: `product ${productId} is published by provider ${definition.providerId}, but yard ${yard.yardId} is on provider ${yard.providerId}`,
					},
				});
		}
	}
	return rejections.sort(
		(a, b) =>
			a.profile.localeCompare(b.profile) ||
			a.rejection.definitionId.localeCompare(b.rejection.definitionId),
	);
}

type YardBindingGate = {
	readonly applicableRows: readonly YardBindingRow[];
	readonly admitted?: ReadonlySet<string>;
	readonly rejections: readonly AttributedRejection[];
	readonly fatal: boolean;
};

function resolveYardBindingGate(
	yard: YardBindingContext,
	requiredProfileIds: readonly string[],
	definitions: readonly ResourceDefinitionVNext[],
): YardBindingGate {
	const wanted = new Set(requiredProfileIds);
	const applicableRows = yard.bindings
		.filter((row) => wanted.has(row.profile))
		.map((row) => [yardBindingRowKey(row), row] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, row]) => row);

	const byProduct = new Map<string, ResourceDefinitionVNext[]>();
	for (const definition of definitions) {
		const productId = definition.semantics?.productId;
		if (productId === undefined) continue;
		const bucket = byProduct.get(productId);
		if (bucket === undefined) byProduct.set(productId, [definition]);
		else bucket.push(definition);
	}

	const rejections: AttributedRejection[] = [
		...validateYardBindingOwnership(yard, definitions),
	];
	const admitted = new Set<string>();
	let pinsProduct = false;

	for (const row of applicableRows) {
		const productId = row.productId;
		if (productId === undefined || productId.length === 0) continue;
		pinsProduct = true;
		const matches = byProduct.get(productId);
		if (matches === undefined || matches.length === 0) continue;
		for (const definition of [...matches].sort((a, b) =>
			a.id.localeCompare(b.id),
		)) {
			if (definition.providerId !== yard.providerId) continue;
			admitted.add(definition.id);
		}
	}

	const fatal = rejections.length > 0;
	return {
		applicableRows,
		...(pinsProduct ? { admitted } : undefined),
		rejections,
		fatal,
	};
}

function mergeRealizationParameters(rows: readonly YardBindingRow[]):
	| {
			readonly parameters: Readonly<JsonObject>;
			readonly rows: readonly string[];
	  }
	| undefined {
	const merged = new Map<string, { value: JsonValue; row: string }>();
	const contributing = new Set<string>();
	for (const row of rows) {
		const properties = row.properties;
		if (properties === undefined) {
			continue;
		}
		const entries = Object.entries(properties);
		if (entries.length === 0) {
			continue;
		}
		const key = yardBindingRowKey(row);
		contributing.add(key);
		for (const [name, value] of entries) {
			const existing = merged.get(name);
			if (
				existing !== undefined &&
				JSON.stringify(existing.value) !== JSON.stringify(value)
			) {
				throw new YardBindingParameterConflictError(name, existing.row, key);
			}
			merged.set(name, { value, row: key });
		}
	}
	if (merged.size === 0) {
		return undefined;
	}
	const parameters: JsonBag = {};
	for (const name of [...merged.keys()].sort()) {
		const entry = merged.get(name);
		if (entry !== undefined) {
			parameters[name] = entry.value;
		}
	}
	return {
		parameters: Object.freeze(parameters),
		rows: Object.freeze([...contributing].sort()),
	};
}

function pinnedConnectivity(
	rows: readonly YardBindingRow[],
): readonly string[] {
	const ids = new Set<string>();
	for (const row of rows) {
		if (row.connectivityId !== undefined && row.connectivityId.length > 0) {
			ids.add(row.connectivityId);
		}
	}
	return [...ids].sort();
}

function realizationFor(
	definition: ResourceDefinitionVNext,
	requiredProfileIds: readonly string[],
	registry: CapabilityProfileRegistry,
): "native" | "pack" | "bridge" {
	const implementations = [
		...(definition.semantics?.implementsProfiles ?? []),
	].sort((a, b) => a.profileId.localeCompare(b.profileId));
	for (const required of [...requiredProfileIds].sort()) {
		for (const implementation of implementations) {
			if (registry.satisfies(implementation.profileId, required)) {
				return implementation.realization;
			}
		}
	}
	return implementations[0]?.realization ?? "native";
}

const UNAVAILABLE_CODE_PRECEDENCE: readonly (
	| YardBindingRejectionCode
	| "NO_COMPATIBLE_BINDING"
)[] = Object.freeze([
	"YARD_BINDING_PRODUCT_UNKNOWN",
	"YARD_BINDING_PROVIDER_MISMATCH",
	"YARD_BINDING_EXCLUDED_ALL",
	"NO_COMPATIBLE_BINDING",
] as const);

function sortRejections(
	records: readonly ProfileMatchRejectionRecord[],
): readonly ProfileMatchRejectionRecord[] {
	return [...records].sort(
		(a, b) =>
			a.definitionId.localeCompare(b.definitionId) ||
			a.code.localeCompare(b.code),
	);
}

function unavailableFact(
	yard: YardBindingContext,
	attributed: readonly AttributedRejection[],
	fallbackProfile: string,
	consideredCount: number,
): BindingUnavailableEvent {
	const ranked = [...attributed].sort(
		(a, b) =>
			UNAVAILABLE_CODE_PRECEDENCE.indexOf(a.rejection.code) -
				UNAVAILABLE_CODE_PRECEDENCE.indexOf(b.rejection.code) ||
			a.profile.localeCompare(b.profile) ||
			a.rejection.definitionId.localeCompare(b.rejection.definitionId),
	);
	const first = ranked[0];
	const code: BindingUnavailableCode =
		first?.rejection.code ?? "NO_COMPATIBLE_BINDING";
	return bindingUnavailable({
		yardId: yard.yardId,
		profile: first?.profile ?? fallbackProfile,
		code,
		remediation: BINDING_UNAVAILABLE_REMEDIATION[code],
		consideredCount,
	});
}

export function matchCapabilityRequirement(
	input: ProfileMatchInput,
): ProfileMatchOutcome {
	const catalogHash = profileCatalogHash(input.definitions, input.profiles);
	const byId = new Map<string, ResourceDefinitionVNext>();
	const candidates: SelectionCandidate[] = [];
	for (const definition of input.definitions) {
		const candidate = toSelectionCandidate(definition);
		if (candidate === undefined) continue;
		byId.set(definition.id, definition);
		candidates.push(candidate);
	}

	const requiredProfileIds = input.requirement.requiredProfiles.map(
		(constraint) => constraint.profileId,
	);
	const fallbackProfile = requiredProfileIds[0] ?? "";
	const required = input.requirement.requiredProfiles
		.map((constraint) => `${constraint.profileId} ${constraint.versionRange}`)
		.join(", ");
	const consideredCount = candidates.length;
	const yard = input.yard;

	const gate =
		yard !== undefined
			? resolveYardBindingGate(yard, requiredProfileIds, input.definitions)
			: undefined;

	if (gate?.fatal === true && yard !== undefined) {
		const rejections = sortRejections(
			gate.rejections.map((entry) => entry.rejection),
		);
		const detail = rejections
			.map(
				(rejection) =>
					`${rejection.definitionId}: ${rejection.code} — ${rejection.detail}`,
			)
			.join("; ");
		const remediation = `yard ${yard.yardId} declares binding rows that do not resolve against the registered catalog: ${detail}. Correct the row's productId, or register a product for provider ${yard.providerId} that declares it.`;
		return {
			ok: false,
			rejections,
			catalogHash,
			remediation: {
				resource: input.resourceName,
				code: "capability.yard-binding-unsatisfiable",
				requiredPort: fallbackProfile,
				requiredFeatures: input.requirement.features.map(
					(feature) => feature.key,
				),
				missing: rejections.map((rejection) => rejection.code),
				remediation,
			},
			bindingUnavailable: unavailableFact(
				yard,
				gate.rejections,
				fallbackProfile,
				consideredCount,
			),
		};
	}

	const admitted = gate?.admitted;
	const gated = candidates.filter(
		(candidate) =>
			(yard === undefined || candidate.providerId === yard.providerId) &&
			(admitted === undefined || admitted.has(candidate.definitionId)),
	);
	const excluded =
		admitted === undefined
			? []
			: candidates
					.filter((candidate) => !admitted.has(candidate.definitionId))
					.map((candidate) => candidate.definitionId)
					.sort();

	const result = selectCapabilityImplementation({
		requirement: input.requirement,
		registry: input.profiles,
		candidates: gated,
		policy: input.policy,
		nowMs: input.nowMs,
		...(input.consumableBindingProfiles !== undefined
			? { consumableBindingProfiles: input.consumableBindingProfiles }
			: undefined),
	});

	if (result.winner === undefined) {
		const rowProfiles = [
			...new Set(
				(gate?.applicableRows ?? [])
					.filter(
						(row) => row.productId !== undefined && row.productId.length > 0,
					)
					.map((row) => row.profile),
			),
		].sort();
		const exclusions: AttributedRejection[] =
			excluded.length > 0 && yard !== undefined
				? excluded.map((definitionId) => ({
						profile: rowProfiles[0] ?? fallbackProfile,
						rejection: {
							definitionId,
							code: "YARD_BINDING_EXCLUDED_ALL" as const,
							detail: `excluded by yard ${yard.yardId} binding rows for ${rowProfiles.join(", ")}, which admit only ${[...(admitted ?? [])].sort().join(", ") || "no registered product"}`,
						},
					}))
				: [];
		const rejections = sortRejections([
			...result.rejections,
			...exclusions.map((entry) => entry.rejection),
		]);
		const detail =
			rejections.length === 0
				? `no registered product declares a capability profile for resource ${input.resourceName}`
				: rejections
						.map(
							(rejection) =>
								`${rejection.definitionId}: ${rejection.code} — ${rejection.detail}`,
						)
						.join("; ");
		const remediation = `no product satisfies ${required} for resource ${input.resourceName} under the active trust policy: ${detail}`;
		return {
			ok: false,
			rejections,
			catalogHash,
			remediation: {
				resource: input.resourceName,
				code: "capability.profile-unsatisfiable",
				requiredPort: fallbackProfile,
				requiredFeatures: input.requirement.features.map(
					(feature) => feature.key,
				),
				missing: rejections.map((rejection) => rejection.code),
				remediation,
			},
			...(yard !== undefined
				? {
						bindingUnavailable: unavailableFact(
							yard,
							exclusions,
							fallbackProfile,
							consideredCount,
						),
					}
				: undefined),
		};
	}

	// SAFETY: `const winner = byId.get(` is required at this I/O or test boundary.
	const winner = byId.get(
		result.winner.definitionId,
	) as ResourceDefinitionVNext;
	const runnerUp = result.ranked[1];
	const tie =
		runnerUp !== undefined &&
		runnerUp.creatorAuthorityAfterClaim ===
			result.winner.creatorAuthorityAfterClaim &&
		runnerUp.claimAtomicity === result.winner.claimAtomicity &&
		runnerUp.claimActionCount === result.winner.claimActionCount &&
		runnerUp.providerClass === result.winner.providerClass &&
		runnerUp.sponsorExposureMinorUnits ===
			result.winner.sponsorExposureMinorUnits;

	let appliedRows: readonly string[] | undefined;
	let realizationParameters: Readonly<JsonObject> | undefined;
	let nonPortableRows: readonly string[] | undefined;
	let resolved: BindingResolvedEvent | undefined;
	if (gate !== undefined && yard !== undefined) {
		appliedRows = Object.freeze(
			gate.applicableRows.map((row) => yardBindingRowKey(row)).sort(),
		);
		const merged = mergeRealizationParameters(gate.applicableRows);
		if (merged !== undefined) {
			realizationParameters = merged.parameters;
			nonPortableRows = merged.rows;
		}
		const connectivity = pinnedConnectivity(gate.applicableRows);
		const connectivityId =
			connectivity.length === 1 ? connectivity[0] : undefined;
		const productId = winner.semantics?.productId;
		if (connectivityId !== undefined && productId !== undefined) {
			resolved = bindingResolved({
				contract: "hobo.binding-resolution/v1",
				yardId: yard.yardId,
				profile: fallbackProfile,
				productId,
				connectivityId,
				realization: realizationFor(winner, requiredProfileIds, input.profiles),
				appliedRows,
				consideredCount,
			});
		}
	}

	return {
		ok: true,
		definition: winner,
		ranking: result.ranked.map((candidate) => candidate.definitionId),
		rejections: result.rejections,
		catalogHash,
		tie,
		...(appliedRows !== undefined ? { appliedRows } : undefined),
		...(realizationParameters !== undefined
			? { realizationParameters }
			: undefined),
		...(nonPortableRows !== undefined ? { nonPortableRows } : undefined),
		...(resolved !== undefined ? { bindingResolved: resolved } : undefined),
	};
}
