import {
	CANONICAL_TYPES,
	type CanonicalType,
	type DatasetSchema,
} from "./canonical.js";
import { DataCoreError } from "./errors.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const MAPPING_FIDELITIES = [
	"exact",
	"widening",
	"constrained",
	"lossy",
] as const;

export type MappingFidelity = (typeof MAPPING_FIDELITIES)[number];

// domain-view: parsed annex entry; wire form is TypeMappingEdge in data-models/data_core.proto.
export interface TypeMappingEdge {
	readonly canonical: CanonicalType;
	readonly native: string;
	readonly write: MappingFidelity;
	readonly read: MappingFidelity;
	readonly note: string;
}

// domain-view: parsed annex; wire form is TypeMappingAnnex in data-models/data_core.proto.
export interface TypeMappingAnnex {
	readonly engine: string;
	readonly edges: readonly TypeMappingEdge[];
}

export const MAPPING_FINDING_CODES = [
	"MAPPING_UNSUPPORTED_TYPE",
	"MAPPING_LOSSY",
	"MAPPING_CONSTRAINED",
	"MAPPING_WIDENING",
] as const;

export type MappingFindingCode = (typeof MAPPING_FINDING_CODES)[number];

// domain-view: computed finding; wire form is MappingFinding in data-models/data_core.proto.
export interface MappingFinding {
	readonly code: MappingFindingCode;
	readonly field: string;
	readonly canonical: CanonicalType;
	readonly fidelity: MappingFidelity | "unsupported";
	readonly waiverKey: string;
	readonly detail: string;
}

function invalid(message: string, field: string): never {
	throw new DataCoreError("INVALID_ENGINE_DECLARATION", message, {
		detail: { field },
	});
}

function isFidelity(value: string): value is MappingFidelity {
	// SAFETY: membership test against the closed tuple of fidelity classes.
	return (MAPPING_FIDELITIES as readonly string[]).includes(value);
}

function isCanonicalType(value: string): value is CanonicalType {
	// SAFETY: membership test against the closed tuple of canonical type names.
	return (CANONICAL_TYPES as readonly string[]).includes(value);
}

export function parseTypeMappingAnnex(
	value: JsonValue | undefined,
): TypeMappingAnnex {
	if (!isJsonObject(value))
		invalid("typeMapping must be an object", "typeMapping");
	const engine = value.engine;
	if (!isJsonString(engine) || engine === "") {
		invalid(
			"typeMapping.engine must be a non-empty string",
			"typeMapping.engine",
		);
	}
	const rawEdges = value.edges;
	if (!isJsonArray(rawEdges)) {
		invalid("typeMapping.edges must be an array", "typeMapping.edges");
	}
	const seen = new Set<CanonicalType>();
	const edges = rawEdges.map((entry, index) => {
		const path = `typeMapping.edges[${index}]`;
		if (!isJsonObject(entry)) invalid("edge must be an object", path);
		const { canonical, native, write, read, note } = entry;
		if (!isJsonString(canonical) || !isCanonicalType(canonical)) {
			invalid("edge.canonical must be a canonical type", `${path}.canonical`);
		}
		if (seen.has(canonical)) {
			invalid(`duplicate edge for ${canonical}`, `${path}.canonical`);
		}
		seen.add(canonical);
		if (!isJsonString(native) || native === "") {
			invalid("edge.native must be a non-empty string", `${path}.native`);
		}
		if (!isJsonString(write) || !isFidelity(write)) {
			invalid("edge.write must be a fidelity class", `${path}.write`);
		}
		if (!isJsonString(read) || !isFidelity(read)) {
			invalid("edge.read must be a fidelity class", `${path}.read`);
		}
		const text = note ?? "";
		if (!isJsonString(text))
			invalid("edge.note must be a string", `${path}.note`);
		if ((write !== "exact" || read !== "exact") && text === "") {
			invalid("a non-exact edge must explain itself in note", `${path}.note`);
		}
		return Object.freeze({ canonical, native, write, read, note: text });
	});
	return Object.freeze({ engine, edges: Object.freeze(edges) });
}

export function typeMappingToJson(annex: TypeMappingAnnex): JsonObject {
	return {
		engine: annex.engine,
		edges: annex.edges.map((edge) => ({
			canonical: edge.canonical,
			native: edge.native,
			write: edge.write,
			read: edge.read,
			note: edge.note,
		})),
	};
}

const RANK: Readonly<Record<MappingFidelity, number>> = Object.freeze({
	exact: 0,
	widening: 1,
	constrained: 2,
	lossy: 3,
});

function worse(left: MappingFidelity, right: MappingFidelity): MappingFidelity {
	return RANK[left] >= RANK[right] ? left : right;
}

const CODE_FOR: Readonly<
	Record<Exclude<MappingFidelity, "exact">, MappingFindingCode>
> = Object.freeze({
	widening: "MAPPING_WIDENING",
	constrained: "MAPPING_CONSTRAINED",
	lossy: "MAPPING_LOSSY",
});

export function composeTypeMapping(
	schema: DatasetSchema,
	source: TypeMappingAnnex,
	target: TypeMappingAnnex,
): readonly MappingFinding[] {
	const findings: MappingFinding[] = [];
	for (const field of schema.fields) {
		const from = source.edges.find((edge) => edge.canonical === field.type);
		const to = target.edges.find((edge) => edge.canonical === field.type);
		const waiverSuffix = `${schema.name}.${field.name}`;
		if (from === undefined || to === undefined) {
			const missing = from === undefined ? source.engine : target.engine;
			findings.push(
				Object.freeze({
					code: "MAPPING_UNSUPPORTED_TYPE",
					field: field.name,
					canonical: field.type,
					fidelity: "unsupported",
					waiverKey: `MAPPING_UNSUPPORTED_TYPE:${waiverSuffix}`,
					detail: `${missing} declares no mapping for ${field.type}`,
				}),
			);
			continue;
		}
		const fidelity = worse(from.read, to.write);
		if (fidelity === "exact") continue;
		const code = CODE_FOR[fidelity];
		const notes = [
			from.read === "exact" ? "" : from.note,
			to.write === "exact" ? "" : to.note,
		]
			.filter((note) => note !== "")
			.join("; ");
		findings.push(
			Object.freeze({
				code,
				field: field.name,
				canonical: field.type,
				fidelity,
				waiverKey: `${code}:${waiverSuffix}`,
				detail: `${source.engine} ${from.native} → ${field.type} → ${target.engine} ${to.native}: ${notes}`,
			}),
		);
	}
	return Object.freeze(findings);
}

export function blockingMappingFindings(
	findings: readonly MappingFinding[],
	waivers: readonly string[],
): readonly MappingFinding[] {
	return findings.filter(
		(finding) =>
			finding.code === "MAPPING_UNSUPPORTED_TYPE" ||
			(finding.code === "MAPPING_LOSSY" &&
				!waivers.includes(finding.waiverKey)),
	);
}
