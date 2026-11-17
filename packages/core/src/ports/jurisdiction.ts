import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

export type JurisdictionId =
	| "eu"
	| "eea"
	| "us"
	| "us-gov"
	| "uk"
	| "ch"
	| "ca"
	| "au"
	| "in"
	| "jp"
	| "br"
	| "global";

export type DataClassification =
	| "public"
	| "internal"
	| "pii"
	| "phi"
	| "pci"
	| "secret";

// domain-view:
export interface JurisdictionRecord {
	readonly id: JurisdictionId;
	readonly name: string;
	readonly legalBasis: readonly string[];
}

export interface ResidencyConstraint {
	readonly classifications: readonly DataClassification[];
	readonly allowedJurisdictions: readonly JurisdictionId[];
	readonly deniedJurisdictions?: readonly JurisdictionId[];
}

export type TransferMechanismMode = "none" | "adequacy" | "adequacy-or-scc";

// domain-view:
export interface TransferMechanismEdge {
	readonly fromJurisdiction: JurisdictionId;
	readonly toJurisdiction: JurisdictionId;
	readonly mechanism: "adequacy" | "scc";
	readonly legalBasis: readonly string[];
}

// domain-view:
export interface TransferBasis {
	readonly mechanism: "intra-jurisdiction" | "adequacy" | "scc";
	readonly fromJurisdiction: JurisdictionId;
	readonly toJurisdiction: JurisdictionId;
	readonly legalBasis: readonly string[];
}

export type ResidencyEvaluation =
	| {
			readonly ok: true;
			readonly region: string;
			readonly regionJurisdictions: readonly JurisdictionId[];
			readonly transferBasis: TransferBasis;
	  }
	| {
			readonly ok: false;
			readonly code:
				| "region-unmapped"
				| "jurisdiction-denied"
				| "jurisdiction-not-allowed";
			readonly region: string;
			readonly regionJurisdictions: readonly JurisdictionId[];
			readonly remediation: string;
	  };

export class JurisdictionParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "JurisdictionParseError";
	}
}

const JURISDICTION_IDS = new Set<JurisdictionId>([
	"eu",
	"eea",
	"us",
	"us-gov",
	"uk",
	"ch",
	"ca",
	"au",
	"in",
	"jp",
	"br",
	"global",
]);

const CLASSIFICATIONS = new Set<DataClassification>([
	"public",
	"internal",
	"pii",
	"phi",
	"pci",
	"secret",
]);

export function parseJurisdictionId(
	value: JsonValue | undefined,
): JurisdictionId {
	if (!isJsonString(value) || !JURISDICTION_IDS.has(value as JurisdictionId)) {
		throw new JurisdictionParseError(
			`unknown jurisdiction id: ${String(value)}`,
		);
	}
	return value as JurisdictionId;
}

export function parseDataClassification(
	value: JsonValue | undefined,
): DataClassification {
	if (
		!isJsonString(value) ||
		!CLASSIFICATIONS.has(value as DataClassification)
	) {
		throw new JurisdictionParseError(
			`unknown data classification: ${String(value)}`,
		);
	}
	return value as DataClassification;
}

export function parseResidencyConstraint(
	value: JsonValue | undefined,
): ResidencyConstraint {
	if (!isJsonObject(value) || value === null) {
		throw new JurisdictionParseError("residency constraint must be an object");
	}
	const input = value as JsonObject;
	const classifications = Array.isArray(input.classifications)
		? input.classifications.map(parseDataClassification)
		: [];
	if (!Array.isArray(input.allowedJurisdictions)) {
		throw new JurisdictionParseError(
			"allowedJurisdictions must be an array of jurisdiction ids",
		);
	}
	const allowed = input.allowedJurisdictions.map(parseJurisdictionId);
	if (allowed.length === 0) {
		throw new JurisdictionParseError(
			"allowedJurisdictions must be non-empty (an empty allow-list would deny everything silently)",
		);
	}
	const denied = Array.isArray(input.deniedJurisdictions)
		? input.deniedJurisdictions.map(parseJurisdictionId)
		: undefined;
	return Object.freeze({
		classifications: Object.freeze(classifications),
		allowedJurisdictions: Object.freeze(allowed),
		...(denied !== undefined
			? { deniedJurisdictions: Object.freeze(denied) }
			: undefined),
	});
}

export const JURISDICTIONS: readonly JurisdictionRecord[] = Object.freeze(
	(
		[
			{
				id: "eu",
				name: "European Union",
				legalBasis: ["GDPR (Reg. 2016/679)"],
			},
			{
				id: "eea",
				name: "European Economic Area",
				legalBasis: [
					"GDPR territorial scope incl. EEA Joint Committee decisions",
				],
			},
			{
				id: "us",
				name: "United States",
				legalBasis: ["sectoral (HIPAA, GLBA, CCPA/CPRA)"],
			},
			{
				id: "us-gov",
				name: "United States federal boundary",
				legalBasis: ["FedRAMP", "ITAR-adjacent hosting programs"],
			},
			{
				id: "uk",
				name: "United Kingdom",
				legalBasis: ["UK GDPR + DPA 2018", "EU adequacy decision (2021)"],
			},
			{
				id: "ch",
				name: "Switzerland",
				legalBasis: ["revFADP", "EU adequacy decision"],
			},
			{
				id: "ca",
				name: "Canada",
				legalBasis: ["PIPEDA", "EU adequacy (commercial orgs)"],
			},
			{ id: "au", name: "Australia", legalBasis: ["Privacy Act 1988 / APPs"] },
			{ id: "in", name: "India", legalBasis: ["DPDP Act 2023"] },
			{ id: "jp", name: "Japan", legalBasis: ["APPI", "EU adequacy decision"] },
			{ id: "br", name: "Brazil", legalBasis: ["LGPD"] },
			{ id: "global", name: "No jurisdiction constraint", legalBasis: [] },
		] as const
	).map((entry) =>
		Object.freeze({
			...entry,
			legalBasis: Object.freeze([...entry.legalBasis]),
		}),
	),
);

export const TRANSFER_MECHANISMS: readonly TransferMechanismEdge[] =
	Object.freeze(
		(
			[
				...(["eu", "eea"] as const).flatMap((from): TransferMechanismEdge[] => [
					{
						fromJurisdiction: from,
						toJurisdiction: "uk",
						mechanism: "adequacy",
						legalBasis: ["EU adequacy decision for the UK (2021)"],
					},
					{
						fromJurisdiction: from,
						toJurisdiction: "ch",
						mechanism: "adequacy",
						legalBasis: ["EU adequacy decision for Switzerland (2000/518/EC)"],
					},
					{
						fromJurisdiction: from,
						toJurisdiction: "jp",
						mechanism: "adequacy",
						legalBasis: ["EU-Japan mutual adequacy decision (2019)"],
					},
					{
						fromJurisdiction: from,
						toJurisdiction: "ca",
						mechanism: "adequacy",
						legalBasis: [
							"EU adequacy decision for Canada (2002/2/EC, PIPEDA commercial)",
						],
					},
					{
						fromJurisdiction: from,
						toJurisdiction: "us",
						mechanism: "adequacy",
						legalBasis: ["EU-US Data Privacy Framework adequacy (2023)"],
					},
					{
						fromJurisdiction: from,
						toJurisdiction: "global",
						mechanism: "scc",
						legalBasis: [
							"GDPR Art. 46(2)(c) standard contractual clauses (2021/914)",
						],
					},
				]),
				{
					fromJurisdiction: "uk",
					toJurisdiction: "eu",
					mechanism: "adequacy",
					legalBasis: ["UK adequacy regulations for the EEA (2021)"],
				},
				{
					fromJurisdiction: "uk",
					toJurisdiction: "eea",
					mechanism: "adequacy",
					legalBasis: ["UK adequacy regulations for the EEA (2021)"],
				},
				{
					fromJurisdiction: "uk",
					toJurisdiction: "global",
					mechanism: "scc",
					legalBasis: ["UK International Data Transfer Agreement (2022)"],
				},
			] as TransferMechanismEdge[]
		).map((edge) =>
			Object.freeze({
				...edge,
				legalBasis: Object.freeze([...edge.legalBasis]),
			}),
		),
	);

export const REGION_JURISDICTIONS: Readonly<
	Record<string, readonly JurisdictionId[]>
> = Object.freeze({
	"us-east-1": ["us"],
	"us-west-2": ["us"],
	"eu-west-1": ["eu", "eea"],
	"eu-central-1": ["eu", "eea"],
	"us-central1": ["us"],
	"us-east1": ["us"],
	"europe-west1": ["eu", "eea"],
	eastus: ["us"],
	eastus2: ["us"],
	westus2: ["us"],
	westeurope: ["eu", "eea"],
	us: ["us"],
	"us-east": ["us"],
	"eu-west": ["eu", "eea"],
	eu: ["eu", "eea"],
	"ap-south": ["in"],
	uk: ["uk"],
	"us-gov-west-1": ["us", "us-gov"],
	global: ["global"],
	local: ["global"],
});

function normalizeRegion(region: string): string {
	return region.trim().toLowerCase();
}

export function jurisdictionsForRegion(
	region: string,
	catalog: Readonly<
		Record<string, readonly JurisdictionId[]>
	> = REGION_JURISDICTIONS,
): readonly JurisdictionId[] {
	return catalog[normalizeRegion(region)] ?? Object.freeze([]);
}

export function evaluateResidency(input: {
	readonly constraint: ResidencyConstraint;
	readonly region: string;
	readonly catalog?: Readonly<Record<string, readonly JurisdictionId[]>>;
	readonly transferMechanisms?: TransferMechanismMode;
	readonly mechanismCatalog?: readonly TransferMechanismEdge[];
}): ResidencyEvaluation {
	const region = normalizeRegion(input.region);
	const regionJurisdictions = jurisdictionsForRegion(region, input.catalog);
	if (regionJurisdictions.length === 0) {
		return Object.freeze({
			ok: false,
			code: "region-unmapped" as const,
			region,
			regionJurisdictions,
			remediation: `region "${region}" has no jurisdiction mapping; add it to the catalog or choose a mapped region`,
		});
	}
	const denied = input.constraint.deniedJurisdictions ?? [];
	const deniedHit = denied.includes("global")
		? "global"
		: regionJurisdictions.find((entry) => denied.includes(entry));
	if (deniedHit !== undefined) {
		return Object.freeze({
			ok: false,
			code: "jurisdiction-denied" as const,
			region,
			regionJurisdictions,
			remediation: `region "${region}" sits in denied jurisdiction "${deniedHit}"`,
		});
	}
	if (regionJurisdictions.includes("global") && denied.length > 0) {
		return Object.freeze({
			ok: false,
			code: "jurisdiction-not-allowed" as const,
			region,
			regionJurisdictions,
			remediation: `region "${region}" has an unrestricted footprint; it cannot prove exclusion of denied jurisdictions [${denied.join(", ")}]`,
		});
	}
	const allowed = input.constraint.allowedJurisdictions;
	const allowedDirect = allowed.includes("global")
		? "global"
		: regionJurisdictions.find((entry) => allowed.includes(entry));
	if (allowedDirect !== undefined) {
		const inside = allowedDirect === "global" ? "global" : allowedDirect;
		return Object.freeze({
			ok: true,
			region,
			regionJurisdictions,
			transferBasis: Object.freeze({
				mechanism: "intra-jurisdiction" as const,
				fromJurisdiction: inside,
				toJurisdiction: inside,
				legalBasis: Object.freeze([] as string[]),
			}),
		});
	}
	const mode = input.transferMechanisms ?? "none";
	if (mode !== "none") {
		const edges = input.mechanismCatalog ?? TRANSFER_MECHANISMS;
		const edge = edges.find(
			(candidate) =>
				allowed.includes(candidate.fromJurisdiction) &&
				(candidate.toJurisdiction === "global" ||
					regionJurisdictions.includes(candidate.toJurisdiction)) &&
				(candidate.mechanism === "adequacy" || mode === "adequacy-or-scc"),
		);
		if (edge !== undefined) {
			return Object.freeze({
				ok: true,
				region,
				regionJurisdictions,
				transferBasis: Object.freeze({
					mechanism: edge.mechanism,
					fromJurisdiction: edge.fromJurisdiction,
					toJurisdiction: edge.toJurisdiction,
					legalBasis: Object.freeze([...edge.legalBasis]),
				}),
			});
		}
	}
	return Object.freeze({
		ok: false,
		code: "jurisdiction-not-allowed" as const,
		region,
		regionJurisdictions,
		remediation: `region "${region}" (${regionJurisdictions.join(", ")}) is outside allowed jurisdictions [${allowed.join(", ")}]${
			mode === "none"
				? ""
				: " and no recognized transfer mechanism connects them"
		}`,
	});
}
