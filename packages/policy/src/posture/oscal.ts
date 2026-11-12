// OSCAL assessment results from posture compliance records (plan 0024 D25),
// beside the control-evidence exporter in ../oscal-export.ts. One OSCAL
// result per compliance record, one observation per evaluated resource and
// one finding per control the record's rules cite. Deterministic: UUIDs are
// name-based (version 5 layout) over a stable seed and timestamps come from
// the records, never a clock. Validated against the pinned OSCAL 1.1.2
// schema in test/posture.
import { createHash } from "node:crypto";
import { isJsonObject } from "../json.js";
import { OSCAL_VERSION } from "../oscal-export.js";
import type { PostureState } from "./evaluate.js";

/** A compliance record as @hobo/cd records it (ComplianceRecord), in plain structural form. */
export type PostureComplianceInput = Readonly<{
	campId: string;
	railDigest: string;
	candidate: boolean;
	state: PostureState;
	/** Decimal journal position of the status observation evaluated. */
	observationPosition: string;
	/** RFC 3339 instant of the evaluation. */
	evaluatedAt: string;
	findings: readonly Readonly<{
		rule: string;
		resource: string;
		state: PostureState;
		severity: string;
		controls: readonly string[];
		observed: string;
		ownershipConflict: boolean;
	}>[];
}>;

export type OscalPostureProp = Readonly<{ name: string; value: string }>;

export type OscalPostureObservation = Readonly<{
	uuid: string;
	title: string;
	description: string;
	props: readonly OscalPostureProp[];
	methods: readonly ["TEST"];
	collected: string;
	remarks?: string;
}>;

export type OscalPostureFinding = Readonly<{
	uuid: string;
	title: string;
	description: string;
	target: Readonly<{
		type: "objective-id";
		"target-id": string;
		status: Readonly<{ state: "satisfied" | "not-satisfied" }>;
	}>;
	"related-observations"?: readonly Readonly<{ "observation-uuid": string }>[];
}>;

export type OscalPostureResult = Readonly<{
	uuid: string;
	title: string;
	description: string;
	start: string;
	end: string;
	props: readonly OscalPostureProp[];
	"reviewed-controls": Readonly<{
		"control-selections": readonly (
			| Readonly<{
					"include-controls": readonly Readonly<{ "control-id": string }>[];
			  }>
			| Readonly<{ "include-all": Readonly<Record<string, never>> }>
		)[];
	}>;
	observations?: readonly OscalPostureObservation[];
	findings: readonly OscalPostureFinding[];
}>;

export type OscalPostureAssessmentResults = Readonly<{
	"assessment-results": Readonly<{
		uuid: string;
		metadata: Readonly<{
			title: string;
			"last-modified": string;
			version: string;
			"oscal-version": string;
		}>;
		"import-ap": Readonly<{ href: string; remarks: string }>;
		results: readonly OscalPostureResult[];
	}>;
}>;

/** A typed refusal of the OSCAL export. */
export class PostureOscalError extends Error {
	readonly code: string;
	readonly remediation: string;
	constructor(code: string, message: string, remediation: string) {
		super(`${code}: ${message}`);
		this.name = "PostureOscalError";
		this.code = code;
		this.remediation = remediation;
	}
}

// public-contract: version string of HoBo posture OSCAL documents.
export const POSTURE_OSCAL_DOCUMENT_VERSION = "hobo-posture-1";

/** Name-based UUID (RFC 4122 version 5 layout over SHA-256): same seed, same id. */
function uuidOf(seed: string): string {
	const hex = createHash("sha256")
		.update(`hobo-posture-oscal|${seed}`, "utf8")
		.digest("hex");
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
		16,
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function deepFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		for (const child of value) deepFreeze(child);
		return Object.freeze(value);
	}
	if (isJsonObject(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		return Object.freeze(value);
	}
	return value;
}

/** OSCAL StringDatatype: non-empty, no surrounding whitespace. */
function oscalString(value: string, fallback: string): string {
	const trimmed = value.trim();
	return trimmed === "" ? fallback : trimmed;
}

function recordKey(record: PostureComplianceInput): string {
	return [
		record.evaluatedAt,
		record.campId,
		record.railDigest,
		record.candidate ? "1" : "0",
		record.observationPosition,
	].join("|");
}

function result(record: PostureComplianceInput): OscalPostureResult {
	const seed = recordKey(record);
	const evaluated = record.findings.filter((f) => f.resource !== "");
	const observations = evaluated.map((finding): OscalPostureObservation => {
		const props: OscalPostureProp[] = [
			{ name: "hobo-rule", value: finding.rule },
			{ name: "hobo-resource", value: finding.resource },
			{ name: "hobo-state", value: finding.state },
			{ name: "hobo-severity", value: finding.severity },
		];
		if (finding.ownershipConflict)
			props.push({ name: "hobo-ownership-conflict", value: "true" });
		return {
			uuid: uuidOf(`${seed}|observation|${finding.rule}|${finding.resource}`),
			title: oscalString(
				`${finding.rule} on ${finding.resource}`,
				finding.rule,
			),
			description: `Posture rule ${finding.rule} evaluated on ${finding.resource}: ${finding.state}.`,
			props,
			methods: ["TEST"],
			collected: record.evaluatedAt,
			...(finding.observed.trim() === "" ? {} : { remarks: finding.observed }),
		};
	});
	const controls = [
		...new Set(
			record.findings.flatMap((f) => f.controls.map((c) => c.toLowerCase())),
		),
	].sort();
	const findings = controls.map((control): OscalPostureFinding => {
		const citing = record.findings.filter((f) =>
			f.controls.some((c) => c.toLowerCase() === control),
		);
		const failing = citing.some(
			(f) => f.state === "noncompliant" || f.state === "unknown",
		);
		const related = citing
			.filter((f) => f.resource !== "")
			.map((f) => ({
				"observation-uuid": uuidOf(
					`${seed}|observation|${f.rule}|${f.resource}`,
				),
			}));
		return {
			uuid: uuidOf(`${seed}|finding|${control}`),
			title: control.toUpperCase(),
			description: `${citing.length} posture finding(s) cite ${control.toUpperCase()}; ${failing ? "at least one is noncompliant or unknown" : "all are compliant or not applicable"}.`,
			target: {
				type: "objective-id",
				"target-id": control,
				status: { state: failing ? "not-satisfied" : "satisfied" },
			},
			...(related.length > 0 ? { "related-observations": related } : {}),
		};
	});
	const props: OscalPostureProp[] = [
		{ name: "hobo-camp", value: record.campId },
		{ name: "hobo-rail-digest", value: record.railDigest },
		{ name: "hobo-candidate", value: record.candidate ? "true" : "false" },
		{ name: "hobo-compliance-state", value: record.state },
	];
	if (record.observationPosition !== "")
		props.push({
			name: "hobo-observation-position",
			value: record.observationPosition,
		});
	return {
		uuid: uuidOf(`${seed}|result`),
		title: `Posture of Camp ${record.campId}${record.candidate ? " (candidate Rail)" : ""}`,
		description: `Continuous posture evaluation of Camp ${record.campId} against Rail ${record.railDigest}: ${record.state}.`,
		start: record.evaluatedAt,
		end: record.evaluatedAt,
		props,
		"reviewed-controls": {
			"control-selections": [
				controls.length > 0
					? { "include-controls": controls.map((c) => ({ "control-id": c })) }
					: { "include-all": {} },
			],
		},
		...(observations.length > 0 ? { observations } : {}),
		findings,
	};
}

/**
 * OSCAL assessment-results for posture compliance records. HoBo exports
 * evidence; it does not attest. Refuses an empty set (OSCAL needs a result).
 */
export function toOscalAssessmentResults(
	records: readonly PostureComplianceInput[],
	options: Readonly<{ title?: string }> = {},
): OscalPostureAssessmentResults {
	if (records.length === 0)
		throw new PostureOscalError(
			"posture-oscal-empty",
			"no compliance records to export",
			"Export after the posture service has evaluated at least one Camp (compliance.Observed).",
		);
	const ordered = [...records].sort((a, b) =>
		recordKey(a) < recordKey(b) ? -1 : recordKey(a) > recordKey(b) ? 1 : 0,
	);
	const lastModified = ordered
		.map((r) => r.evaluatedAt)
		.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
	const seed = ordered.map(recordKey).join(";");
	return deepFreeze({
		"assessment-results": {
			uuid: uuidOf(`document|${seed}`),
			metadata: {
				title: oscalString(
					options.title ?? "",
					"HoBo posture assessment results",
				),
				"last-modified": lastModified,
				version: POSTURE_OSCAL_DOCUMENT_VERSION,
				"oscal-version": OSCAL_VERSION,
			},
			"import-ap": {
				href: "#hobo-posture-continuous-assessment",
				remarks:
					"Continuous posture evaluation by the HoBo posture service; the plan is the Rails' bound posture packs.",
			},
			results: ordered.map(result),
		},
	});
}
