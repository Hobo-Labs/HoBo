/**
 * OSCAL-JSON boundary emitter (ADR-0146 iteration hook; posture from
 * docs/standards/oscal.md + ADR-0144): shapes HoBo's control→evidence packs
 * and coverage reports like OSCAL component-definition / assessment-results
 * documents — plain JSON, zero OSCAL schema dependency. HoBo exports
 * evidence; it does not attest. Outputs are deterministic (UUIDs derive from
 * a stable digest, never randomness or clocks) and deeply frozen.
 */

import { createHash } from "node:crypto";
import type {
	ControlCoverageReport,
	ControlEvidencePack,
} from "./control-evidence-pack.js";
import { isJsonObject } from "./json.js";

// public-contract: OSCAL model version the boundary emitter vocabulary targets.
export const OSCAL_VERSION = "1.1.2";

export type OscalExportKind = "component-definition" | "assessment-results";

/** Wire summary of one boundary export (see OscalExportSummaryRecord). */
export interface OscalExportSummary {
	readonly kind: OscalExportKind;
	readonly framework: string;
	readonly version: string;
	readonly control_count: number;
}

export interface OscalProp {
	readonly name: string;
	readonly value: string;
}

export interface OscalImplementedRequirement {
	readonly uuid: string;
	readonly "control-id": string;
	readonly description: string;
	readonly props: readonly OscalProp[];
}

export interface OscalControlImplementation {
	readonly uuid: string;
	readonly source: string;
	readonly description: string;
	readonly "implemented-requirements": readonly OscalImplementedRequirement[];
}

export interface OscalComponent {
	readonly uuid: string;
	readonly type: "software";
	readonly title: string;
	readonly description: string;
	readonly "control-implementations": readonly OscalControlImplementation[];
}

export interface OscalComponentDefinitionDocument {
	readonly "component-definition": {
		readonly uuid: string;
		readonly metadata: {
			readonly title: string;
			readonly version: string;
			readonly "oscal-version": string;
		};
		readonly components: readonly OscalComponent[];
	};
}

export interface OscalFinding {
	readonly uuid: string;
	readonly title: string;
	readonly target: {
		readonly type: "objective-id";
		readonly "target-id": string;
		readonly status: {
			readonly state: "satisfied" | "not-satisfied";
		};
		readonly remarks?: string;
	};
}

export interface OscalAssessmentResultsDocument {
	readonly "assessment-results": {
		readonly uuid: string;
		readonly metadata: {
			readonly title: string;
			readonly version: string;
			readonly "oscal-version": string;
		};
		readonly results: readonly {
			readonly uuid: string;
			readonly title: string;
			readonly description: string;
			readonly findings: readonly OscalFinding[];
		}[];
	};
}

/**
 * Deterministic UUID: sha256 of a stable seed, first 32 hex chars formatted
 * 8-4-4-4-12. Same inputs, same document — no Math.random, no Date.now.
 */
function deterministicUuid(seed: string): string {
	const hex = createHash("sha256").update(seed, "utf8").digest("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join("-");
}

function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined || Object.isFrozen(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		for (const child of value) {
			deepFreeze(child);
		}
		return Object.freeze(value);
	}
	if (!isJsonObject(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function uuidSeedBase(pack: ControlEvidencePack, title: string): string {
	return `hobo-oscal|${pack.framework}|${pack.version}|${title}`;
}

export interface OscalComponentDefinitionOptions {
	readonly componentTitle: string;
	readonly componentDescription?: string;
}

/**
 * Emit an OSCAL component-definition–shaped document: one component, one
 * control-implementation per pack, one implemented-requirement per control
 * with `hobo-status` / `hobo-evidence` props carrying the honest join.
 */
export function emitOscalComponentDefinition(
	pack: ControlEvidencePack,
	options: OscalComponentDefinitionOptions,
): OscalComponentDefinitionDocument {
	if (options.componentTitle === "") {
		throw new TypeError("componentTitle must be non-empty");
	}
	const base = uuidSeedBase(pack, options.componentTitle);
	const requirements = pack.controls.map(
		(control): OscalImplementedRequirement => ({
			uuid: deterministicUuid(`${base}|requirement|${control.controlId}`),
			"control-id": control.controlId.toLowerCase(),
			description: `${control.title} — evidence: ${control.evidence
				.map((entry) => entry.ref)
				.join(", ")}`,
			props: [
				{ name: "hobo-status", value: control.status },
				...control.evidence.map((entry) => ({
					name: "hobo-evidence",
					value: entry.ref,
				})),
			],
		}),
	);
	return deepFreeze({
		"component-definition": {
			uuid: deterministicUuid(`${base}|component-definition`),
			metadata: {
				title: options.componentTitle,
				version: pack.version,
				"oscal-version": OSCAL_VERSION,
			},
			components: [
				{
					uuid: deterministicUuid(`${base}|component`),
					type: "software" as const,
					title: options.componentTitle,
					description:
						options.componentDescription ??
						`HoBo control→evidence pack for ${pack.framework} ${pack.version}`,
					"control-implementations": [
						{
							uuid: deterministicUuid(`${base}|control-implementation`),
							source: pack.framework,
							description: `Control implementations declared by ${pack.framework} ${pack.version} control→evidence pack`,
							"implemented-requirements": requirements,
						},
					],
				},
			],
		},
	});
}

/**
 * Emit an OSCAL assessment-results–shaped document from a coverage report:
 * one finding per control, `satisfied` when coverage held, otherwise
 * `not-satisfied` with the missing evidence refs named in remarks.
 */
export function emitOscalAssessmentEvidence(
	report: ControlCoverageReport,
	pack: ControlEvidencePack,
): OscalAssessmentResultsDocument {
	if (report.framework !== pack.framework) {
		throw new TypeError(
			`coverage report framework ${report.framework} does not match pack framework ${pack.framework}`,
		);
	}
	const base = uuidSeedBase(pack, "assessment");
	const missingByControl = new Map(
		report.missing.map((entry) => [entry.controlId, entry.missingRefs]),
	);
	const findings = pack.controls.map((control): OscalFinding => {
		const missingRefs = missingByControl.get(control.controlId);
		return {
			uuid: deterministicUuid(`${base}|finding|${control.controlId}`),
			title: control.title,
			target: {
				type: "objective-id" as const,
				"target-id": control.controlId.toLowerCase(),
				status: {
					state: missingRefs === undefined ? "satisfied" : "not-satisfied",
				},
				...(missingRefs === undefined
					? undefined
					: { remarks: `missing evidence: ${missingRefs.join(", ")}` }),
			},
		};
	});
	return deepFreeze({
		"assessment-results": {
			uuid: deterministicUuid(`${base}|assessment-results`),
			metadata: {
				title: `${pack.framework} ${pack.version} coverage assessment`,
				version: pack.version,
				"oscal-version": OSCAL_VERSION,
			},
			results: [
				{
					uuid: deterministicUuid(`${base}|result`),
					title: `Coverage evaluation for ${pack.framework}`,
					description: `${report.satisfied}/${report.total} controls satisfied by the available evidence set`,
					findings,
				},
			],
		},
	});
}

/** Wire summary of an export (mirrors OscalExportSummaryRecord proto/CUE). */
export function summarizeOscalExport(
	kind: OscalExportKind,
	pack: ControlEvidencePack,
): OscalExportSummary {
	return Object.freeze({
		kind,
		framework: pack.framework,
		version: pack.version,
		control_count: pack.controls.length,
	});
}
