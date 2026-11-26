/**
 * Control→evidence packs (ADR-0146, realizing ADR-0060 §4's "frameworks are
 * declarative control→evidence packs"): a typed join declaring which HoBo
 * evidence satisfies which control of a recognized framework, plus a coverage
 * evaluator. Vocabulary aligns with OSCAL's component-definition /
 * control-implementation shapes (docs/standards/oscal.md) WITHOUT depending
 * on OSCAL schemas — ADR-0144 posture: inspired by / maps to, never depends
 * on. HoBo exports evidence; it does not run an attestation program
 * (governance-planes scope).
 */

// public-contract: control-evidence pack schema id consumers pin.
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const CONTROL_EVIDENCE_PACK_SCHEMA = "hobo.control-evidence-pack/v1";

export type ControlEvidenceKind =
	| "event-stream"
	| "gate"
	| "artifact"
	| "retention";

export interface ControlEvidenceRef {
	readonly kind: ControlEvidenceKind;
	/** Stable evidence id, e.g. `event-stream:policy.Decided`. */
	readonly ref: string;
}

export type ControlStatus = "implemented" | "partial" | "planned";

export interface ControlMapping {
	readonly controlId: string;
	readonly title: string;
	readonly evidence: readonly ControlEvidenceRef[];
	readonly status: ControlStatus;
}

export interface ControlEvidencePack {
	readonly schema: typeof CONTROL_EVIDENCE_PACK_SCHEMA;
	readonly framework: string;
	readonly version: string;
	readonly controls: readonly ControlMapping[];
}

export class ControlEvidenceParseError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "ControlEvidenceParseError";
	}
}

const EVIDENCE_KINDS = new Set<ControlEvidenceKind>([
	"event-stream",
	"gate",
	"artifact",
	"retention",
]);
const STATUSES = new Set<ControlStatus>(["implemented", "partial", "planned"]);

/** Parse-don't-validate boundary for untrusted pack documents. */
export function parseControlEvidencePack(
	value: JsonValue,
): ControlEvidencePack {
	if (!isJsonObject(value) || value === null) {
		throw new ControlEvidenceParseError("pack must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const input = value as JsonObject;
	if (input.schema !== CONTROL_EVIDENCE_PACK_SCHEMA) {
		throw new ControlEvidenceParseError(
			`schema must be ${CONTROL_EVIDENCE_PACK_SCHEMA}`,
		);
	}
	for (const field of ["framework", "version"] as const) {
		if (!isJsonString(input[field]) || input[field] === "") {
			throw new ControlEvidenceParseError(`${field} must be non-empty`);
		}
	}
	if (!Array.isArray(input.controls) || input.controls.length === 0) {
		throw new ControlEvidenceParseError("controls must be non-empty");
	}
	const seen = new Set<string>();
	const controls = input.controls.map((entry) => {
		// SAFETY: assertion required at this I/O or test boundary.
		const control = entry as JsonObject;
		if (!isJsonString(control.controlId) || control.controlId === "") {
			throw new ControlEvidenceParseError("controlId must be non-empty");
		}
		if (seen.has(control.controlId)) {
			throw new ControlEvidenceParseError(
				`duplicate controlId ${control.controlId}`,
			);
		}
		seen.add(control.controlId);
		if (!isJsonString(control.title) || control.title === "") {
			throw new ControlEvidenceParseError("control title must be non-empty");
		}
		if (
			!isJsonString(control.status) ||
			// SAFETY: assertion required at this I/O or test boundary.
			!STATUSES.has(control.status as ControlStatus)
		) {
			throw new ControlEvidenceParseError(
				`control ${control.controlId} status must be implemented|partial|planned`,
			);
		}
		if (!Array.isArray(control.evidence) || control.evidence.length === 0) {
			throw new ControlEvidenceParseError(
				`control ${control.controlId} must cite at least one evidence ref`,
			);
		}
		const evidence = control.evidence.map((raw) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const item = raw as JsonObject;
			if (
				!isJsonString(item.kind) ||
				// SAFETY: assertion required at this I/O or test boundary.
				!EVIDENCE_KINDS.has(item.kind as ControlEvidenceKind)
			) {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence kind must be one of ${[...EVIDENCE_KINDS].join("|")}`,
				);
			}
			if (!isJsonString(item.ref) || item.ref === "") {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence ref must be non-empty`,
				);
			}
			return Object.freeze({
				// SAFETY: assertion required at this I/O or test boundary.
				kind: item.kind as ControlEvidenceKind,
				ref: item.ref,
			});
		});
		return Object.freeze({
			controlId: control.controlId,
			title: control.title,
			evidence: Object.freeze(evidence),
			// SAFETY: assertion required at this I/O or test boundary.
			status: control.status as ControlStatus,
		});
	});
	return Object.freeze({
		schema: CONTROL_EVIDENCE_PACK_SCHEMA,
		// SAFETY: assertion required at this I/O or test boundary.
		framework: input.framework as string,
		// SAFETY: assertion required at this I/O or test boundary.
		version: input.version as string,
		controls: Object.freeze(controls),
	});
}

export interface ControlCoverageReport {
	readonly framework: string;
	readonly total: number;
	readonly satisfied: number;
	/** satisfied / total, 0..1 */
	readonly coverage: number;
	readonly missing: readonly {
		readonly controlId: string;
		readonly missingRefs: readonly string[];
	}[];
}

/**
 * Coverage: a control is satisfied when EVERY cited evidence ref is present
 * in the available-evidence set. `planned` controls are never counted as
 * satisfied regardless of evidence — the pack's own status is honest first.
 */
export function evaluateControlCoverage(
	pack: ControlEvidencePack,
	availableEvidence: readonly string[],
): ControlCoverageReport {
	const available = new Set(availableEvidence);
	const missing: { controlId: string; missingRefs: readonly string[] }[] = [];
	let satisfied = 0;
	for (const control of pack.controls) {
		const missingRefs = control.evidence
			.filter((entry) => !available.has(entry.ref))
			.map((entry) => entry.ref);
		if (missingRefs.length === 0 && control.status !== "planned") {
			satisfied += 1;
		} else {
			missing.push({
				controlId: control.controlId,
				missingRefs: Object.freeze(
					missingRefs.length > 0 ? missingRefs : ["status:planned"],
				),
			});
		}
	}
	return Object.freeze({
		framework: pack.framework,
		total: pack.controls.length,
		satisfied,
		coverage: pack.controls.length === 0 ? 0 : satisfied / pack.controls.length,
		missing: Object.freeze(missing.map((entry) => Object.freeze(entry))),
	});
}

/**
 * Seed pack: a small, honest NIST SP 800-53 rev5 subset mapped to evidence
 * HoBo actually has (implemented) or has designed (partial/planned). This is
 * a starting vocabulary, not a compliance claim — HoBo exports evidence for
 * external GRC programs; it does not attest.
 */
export const NIST_800_53_SEED_PACK: ControlEvidencePack =
	parseControlEvidencePack({
		schema: CONTROL_EVIDENCE_PACK_SCHEMA,
		framework: "NIST SP 800-53",
		version: "rev5-seed",
		controls: [
			{
				controlId: "AC-3",
				title: "Access enforcement",
				status: "implemented",
				evidence: [
					{ kind: "event-stream", ref: "event-stream:policy.Decided" },
					{ kind: "gate", ref: "gate:gatekeeper.Decided" },
				],
			},
			{
				controlId: "AC-6",
				title: "Least privilege",
				status: "implemented",
				evidence: [
					{ kind: "gate", ref: "gate:capability-grants" },
					{ kind: "event-stream", ref: "event-stream:policy.Decided" },
				],
			},
			{
				controlId: "AU-2",
				title: "Event logging",
				status: "implemented",
				evidence: [
					{ kind: "event-stream", ref: "event-stream:journal-append-only" },
				],
			},
			{
				controlId: "AU-9",
				title: "Protection of audit information",
				status: "implemented",
				evidence: [
					{
						kind: "retention",
						ref: "retention:credential-audit-never-compact",
					},
				],
			},
			{
				controlId: "AU-11",
				title: "Audit record retention",
				status: "implemented",
				evidence: [
					{
						kind: "retention",
						ref: "retention:credential-audit-never-compact",
					},
				],
			},
			{
				controlId: "CM-3",
				title: "Configuration change control",
				status: "implemented",
				evidence: [
					{ kind: "gate", ref: "gate:can-deploy" },
					{ kind: "event-stream", ref: "event-stream:gatekeeper.Decided" },
				],
			},
			{
				controlId: "SA-11",
				title: "Developer testing & evaluation",
				status: "partial",
				evidence: [
					{ kind: "artifact", ref: "artifact:conformance-report" },
					{ kind: "artifact", ref: "artifact:cyclonedx-sbom" },
				],
			},
			{
				controlId: "SI-12",
				title: "Information management & retention (erasure)",
				status: "partial",
				evidence: [{ kind: "artifact", ref: "artifact:crypto-shred-erasure" }],
			},
			{
				controlId: "AU-6",
				title: "Audit review, analysis & reporting",
				status: "planned",
				evidence: [{ kind: "artifact", ref: "artifact:ocsf-export" }],
			},
		],
	});
