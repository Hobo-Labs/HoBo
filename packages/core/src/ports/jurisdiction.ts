/**
 * Legal-jurisdiction vocabulary + residency evaluation (ADR-0146).
 *
 * Regions are provider facts (free tokens in capability manifests);
 * jurisdictions are legal facts; this module owns the typed join and the
 * pure, deterministic evaluator that turns "constraint + target region" into
 * an explicit verdict. It produces the `residencyConflict` inputs that
 * `can-trail` / `can-migrate` already consume and the `residency` gate reason
 * Gatekeeper reports. Open-spec anchors for the seed vocabulary: GDPR
 * territorial scope + EU adequacy decisions, the EEA, FedRAMP's US federal
 * boundary, and provider sovereignty controls (e.g. Cloudflare's
 * `jurisdiction: "eu" | "fedramp"` knob) — cited as legalBasis strings, never
 * depended on (ADR-0144 posture).
 */

// domain-view: parse-time vocabulary; wire form in data-models/jurisdiction.proto.
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

/** Data-classification labels (governance-planes Plan 46), now typed. */
export type DataClassification =
	| "public"
	| "internal"
	| "pii"
	| "phi"
	| "pci"
	| "secret";

// domain-view: parse-time catalog entry; wire form is JurisdictionRecord in data-models/jurisdiction.proto (_generated/jurisdiction_pb.ts).
export interface JurisdictionRecord {
	readonly id: JurisdictionId;
	readonly name: string;
	/** Citations (spec/program names), informational — never a dependency. */
	readonly legalBasis: readonly string[];
}

export interface ResidencyConstraint {
	/** Classifications the constraint applies to; empty = all data. */
	readonly classifications: readonly DataClassification[];
	readonly allowedJurisdictions: readonly JurisdictionId[];
	readonly deniedJurisdictions?: readonly JurisdictionId[];
}

/** Which lawful transfer mechanisms an evaluation may rely on. Default is
 * "none": a region must sit directly inside an allowed jurisdiction. */
export type TransferMechanismMode = "none" | "adequacy" | "adequacy-or-scc";

// domain-view: catalog entry; wire form is TransferMechanismRecord in data-models/jurisdiction.proto.
export interface TransferMechanismEdge {
	readonly fromJurisdiction: JurisdictionId;
	readonly toJurisdiction: JurisdictionId;
	readonly mechanism: "adequacy" | "scc";
	/** Citations (decision/instrument names), informational — never a dependency. */
	readonly legalBasis: readonly string[];
}

// domain-view: evaluation output; wire form is TransferBasisRecord in data-models/jurisdiction.proto.
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
	if (
		!isJsonString(value) ||
		// SAFETY: assertion required at this I/O or test boundary.
		!JURISDICTION_IDS.has(value as JurisdictionId)
	) {
		throw new JurisdictionParseError(
			`unknown jurisdiction id: ${String(value)}`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as JurisdictionId;
}

export function parseDataClassification(
	value: JsonValue | undefined,
): DataClassification {
	if (
		!isJsonString(value) ||
		// SAFETY: assertion required at this I/O or test boundary.
		!CLASSIFICATIONS.has(value as DataClassification)
	) {
		throw new JurisdictionParseError(
			`unknown data classification: ${String(value)}`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return value as DataClassification;
}

export function parseResidencyConstraint(
	value: JsonValue | undefined,
): ResidencyConstraint {
	if (!isJsonObject(value) || value === null) {
		throw new JurisdictionParseError("residency constraint must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
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

/** Seed jurisdiction catalog with informational legal-basis citations. */
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

/**
 * Region-token → jurisdictions seed map. Region tokens are the ones providers
 * actually publish today (aws/gcp style, coarse doc tokens, cloudflare colos
 * modeled as `global`, and the local/dev token). Membership is deliberately
 * conservative: an EU region is `["eu", "eea"]`; a UK region is only `["uk"]`.
 * `local` maps to `global` (self-host: the operator's own premises are their
 * own legal problem — HoBo does not guess).
 */
/**
 * Seed transfer-mechanism catalog (ADR-0146 v2): real adequacy decisions and
 * the SCC instrument as data edges. Deliberately small and honest — every
 * edge cites its instrument; absence of an edge means the transfer has no
 * recognized basis here (fail-closed).
 */
export const TRANSFER_MECHANISMS: readonly TransferMechanismEdge[] =
	Object.freeze(
		// SAFETY: assertion required at this I/O or test boundary.
		(
			[
				// EU/EEA adequacy decisions (GDPR Art. 45).
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
				// UK retained-GDPR mirrors of the same instruments.
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
	// aws-style
	"us-east-1": ["us"],
	"us-west-2": ["us"],
	"eu-west-1": ["eu", "eea"],
	"eu-central-1": ["eu", "eea"],
	// gcp-style
	"us-central1": ["us"],
	"us-east1": ["us"],
	"europe-west1": ["eu", "eea"],
	// coarse doc tokens
	us: ["us"],
	"us-east": ["us"],
	"eu-west": ["eu", "eea"],
	eu: ["eu", "eea"],
	"ap-south": ["in"],
	uk: ["uk"],
	// sovereign/federal
	"us-gov-west-1": ["us", "us-gov"],
	// provider-neutral
	global: ["global"],
	local: ["global"],
});

function normalizeRegion(region: string): string {
	return region.trim().toLowerCase();
}

/** Jurisdictions a region token sits in, or empty when unmapped. */
export function jurisdictionsForRegion(
	region: string,
	catalog: Readonly<
		Record<string, readonly JurisdictionId[]>
	> = REGION_JURISDICTIONS,
): readonly JurisdictionId[] {
	return catalog[normalizeRegion(region)] ?? Object.freeze([]);
}

/**
 * Pure, deterministic residency evaluation. Fail-closed: an unmapped region
 * is a conflict, never a pass — geography the platform cannot attest is
 * geography the constraint cannot allow.
 */
export function evaluateResidency(input: {
	readonly constraint: ResidencyConstraint;
	readonly region: string;
	readonly catalog?: Readonly<Record<string, readonly JurisdictionId[]>>;
	/**
	 * Lawful transfer mechanisms the evaluation may rely on when the region is
	 * not directly inside an allowed jurisdiction (ADR-0146 v2). Default
	 * "none" preserves strict fail-closed behavior; opting in never bypasses
	 * denied jurisdictions or unmapped regions.
	 */
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
	const deniedHit = regionJurisdictions.find((entry) => denied.includes(entry));
	if (deniedHit !== undefined) {
		return Object.freeze({
			ok: false,
			code: "jurisdiction-denied" as const,
			region,
			regionJurisdictions,
			remediation: `region "${region}" sits in denied jurisdiction "${deniedHit}"`,
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
				// SAFETY: assertion required at this I/O or test boundary.
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
