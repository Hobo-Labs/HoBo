import { isJsonObject, isJsonString, type JsonValue } from "./json.js";

export const CONTROL_EVIDENCE_PACK_SCHEMA = "hobo.control-evidence-pack/v1";

export type ControlEvidenceKind =
	| "event-stream"
	| "gate"
	| "artifact"
	| "retention";

export interface ControlEvidenceRef {
	readonly kind: ControlEvidenceKind;
	readonly ref: string;
}

export interface RegisteredControlEvidence extends ControlEvidenceRef {
	readonly owner: string;
	readonly binding: string;
}

export const CONTROL_EVIDENCE_REGISTRY = Object.freeze({
	policyDecisionEvent: Object.freeze({
		kind: "event-stream",
		ref: "event-stream:policy.Decided",
		owner: "@hobo/contracts",
		binding: "POLICY_DECIDED_EVENT_TYPE",
	}),
	gatekeeperDecisionEvent: Object.freeze({
		kind: "event-stream",
		ref: "event-stream:gatekeeper.Decided",
		owner: "@hobo/contracts",
		binding: "GATEKEEPER_DECIDED_EVENT",
	}),
	connectionRevokedEvent: Object.freeze({
		kind: "event-stream",
		ref: "event-stream:connection.Revoked",
		owner: "@hobo/identity",
		binding: "CONNECTION_EVENTS.Revoked",
	}),
	migrationSnapshotTakenEvent: Object.freeze({
		kind: "event-stream",
		ref: "event-stream:migration.SnapshotTaken",
		owner: "@hobo/trails",
		binding: "MIGRATION_EVENTS.SnapshotTaken",
	}),
	subjectErasureRequestedEvent: Object.freeze({
		kind: "event-stream",
		ref: "event-stream:subject.ErasureRequested",
		owner: "@hobo/cloud",
		binding: "CLOUD_EVENTS.SubjectErasureRequested",
	}),
	appendOnlyJournal: Object.freeze({
		kind: "event-stream",
		ref: "event-stream:journal-append-only",
		owner: "@hobo/data",
		binding: "EventStore.append",
	}),
	gatekeeper: Object.freeze({
		kind: "gate",
		ref: "gate:gatekeeper",
		owner: "@hobo/contracts",
		binding: "evaluateGatekeeper",
	}),
	capabilityGrants: Object.freeze({
		kind: "gate",
		ref: "gate:capability-grants",
		owner: "@hobo/core",
		binding: "evaluateCapabilityGrants",
	}),
	canDeploy: Object.freeze({
		kind: "gate",
		ref: "gate:can-deploy",
		owner: "@hobo/contracts",
		binding: "evaluateCanDeploy",
	}),
	residency: Object.freeze({
		kind: "gate",
		ref: "gate:residency",
		owner: "@hobo/policy",
		binding: "evaluateResidencyPolicy",
	}),
	conformanceReport: Object.freeze({
		kind: "artifact",
		ref: "artifact:conformance-report",
		owner: "@hobo/conformance",
		binding: "CD_CONFORMANCE_REPORT_SCHEMA",
	}),
	cycloneDxSbom: Object.freeze({
		kind: "artifact",
		ref: "artifact:cyclonedx-sbom",
		owner: ".github/actions/release-oci-attest",
		binding: "syft cyclonedx-json",
	}),
	ocsfExport: Object.freeze({
		kind: "artifact",
		ref: "artifact:ocsf-export",
		owner: "@hobo/hobo",
		binding: "OCSF_EXPORT_VERSION",
	}),
	credentialAuditRetention: Object.freeze({
		kind: "retention",
		ref: "retention:credential-audit-never-compact",
		owner: "@hobo/trails",
		binding: "credential-audit-never-compact",
	}),
} satisfies Record<string, RegisteredControlEvidence>);

const CONTROL_EVIDENCE_BY_REF: ReadonlyMap<string, RegisteredControlEvidence> =
	new Map<string, RegisteredControlEvidence>(
		Object.values(CONTROL_EVIDENCE_REGISTRY).map((entry) => [entry.ref, entry]),
	);

export function resolveControlEvidenceRef(
	ref: string,
): RegisteredControlEvidence | undefined {
	return CONTROL_EVIDENCE_BY_REF.get(ref);
}

export type ControlStatus = "implemented";

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
export function parseControlEvidencePack(
	value: JsonValue,
): ControlEvidencePack {
	if (!isJsonObject(value)) {
		throw new ControlEvidenceParseError("pack must be an object");
	}
	const input = value;
	if (input.schema !== CONTROL_EVIDENCE_PACK_SCHEMA) {
		throw new ControlEvidenceParseError(
			`schema must be ${CONTROL_EVIDENCE_PACK_SCHEMA}`,
		);
	}
	if (!isJsonString(input.framework) || input.framework === "") {
		throw new ControlEvidenceParseError("framework must be non-empty");
	}
	if (!isJsonString(input.version) || input.version === "") {
		throw new ControlEvidenceParseError("version must be non-empty");
	}
	if (!Array.isArray(input.controls) || input.controls.length === 0) {
		throw new ControlEvidenceParseError("controls must be non-empty");
	}
	const seen = new Set<string>();
	const controls = input.controls.map((entry) => {
		if (!isJsonObject(entry)) {
			throw new ControlEvidenceParseError("control must be an object");
		}
		const control = entry;
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
		if (!isJsonString(control.status) || control.status !== "implemented") {
			throw new ControlEvidenceParseError(
				`control ${control.controlId} status must be implemented`,
			);
		}
		if (!Array.isArray(control.evidence) || control.evidence.length === 0) {
			throw new ControlEvidenceParseError(
				`control ${control.controlId} must cite at least one evidence ref`,
			);
		}
		const evidence = control.evidence.map((raw) => {
			if (!isJsonObject(raw)) {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence must be an object`,
				);
			}
			const item = raw;
			if (!isControlEvidenceKind(item.kind)) {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence kind must be one of ${[...EVIDENCE_KINDS].join("|")}`,
				);
			}
			if (!isJsonString(item.ref) || item.ref === "") {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence ref must be non-empty`,
				);
			}
			const registered = resolveControlEvidenceRef(item.ref);
			if (!registered) {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence ref is not registered: ${item.ref}`,
				);
			}
			if (registered.kind !== item.kind) {
				throw new ControlEvidenceParseError(
					`control ${control.controlId} evidence kind ${item.kind} does not match registered kind ${registered.kind} for ${item.ref}`,
				);
			}
			return Object.freeze({
				kind: registered.kind,
				ref: registered.ref,
			});
		});
		return Object.freeze({
			controlId: control.controlId,
			title: control.title,
			evidence: Object.freeze(evidence),
			status: "implemented",
		});
	});
	return Object.freeze({
		schema: CONTROL_EVIDENCE_PACK_SCHEMA,
		framework: input.framework,
		version: input.version,
		controls: Object.freeze(controls),
	});
}

function isControlEvidenceKind(
	value: JsonValue | undefined,
): value is ControlEvidenceKind {
	return (
		value === "event-stream" ||
		value === "gate" ||
		value === "artifact" ||
		value === "retention"
	);
}

export interface ControlCoverageReport {
	readonly framework: string;
	readonly total: number;
	readonly satisfied: number;
	readonly coverage: number;
	readonly missing: readonly {
		readonly controlId: string;
		readonly missingRefs: readonly string[];
	}[];
}

export function evaluateControlCoverage(
	pack: ControlEvidencePack,
	availableEvidence: readonly string[],
): ControlCoverageReport {
	for (const ref of availableEvidence) {
		if (!resolveControlEvidenceRef(ref)) {
			throw new ControlEvidenceParseError(
				`available evidence ref is not registered: ${ref}`,
			);
		}
	}
	const available = new Set(availableEvidence);
	const missing: { controlId: string; missingRefs: readonly string[] }[] = [];
	let satisfied = 0;
	for (const control of pack.controls) {
		const missingRefs = control.evidence
			.filter((entry) => !available.has(entry.ref))
			.map((entry) => entry.ref);
		if (missingRefs.length === 0) {
			satisfied += 1;
		} else {
			missing.push({
				controlId: control.controlId,
				missingRefs: Object.freeze(missingRefs),
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
					CONTROL_EVIDENCE_REGISTRY.policyDecisionEvent,
					CONTROL_EVIDENCE_REGISTRY.gatekeeper,
				],
			},
			{
				controlId: "AC-6",
				title: "Least privilege",
				status: "implemented",
				evidence: [
					CONTROL_EVIDENCE_REGISTRY.capabilityGrants,
					CONTROL_EVIDENCE_REGISTRY.policyDecisionEvent,
				],
			},
			{
				controlId: "AU-2",
				title: "Event logging",
				status: "implemented",
				evidence: [CONTROL_EVIDENCE_REGISTRY.appendOnlyJournal],
			},
			{
				controlId: "AU-9",
				title: "Protection of audit information",
				status: "implemented",
				evidence: [CONTROL_EVIDENCE_REGISTRY.credentialAuditRetention],
			},
			{
				controlId: "AU-11",
				title: "Audit record retention",
				status: "implemented",
				evidence: [CONTROL_EVIDENCE_REGISTRY.credentialAuditRetention],
			},
			{
				controlId: "CM-3",
				title: "Configuration change control",
				status: "implemented",
				evidence: [
					CONTROL_EVIDENCE_REGISTRY.canDeploy,
					CONTROL_EVIDENCE_REGISTRY.gatekeeperDecisionEvent,
				],
			},
			{
				controlId: "SA-11",
				title: "Developer testing & evaluation",
				status: "implemented",
				evidence: [
					CONTROL_EVIDENCE_REGISTRY.conformanceReport,
					CONTROL_EVIDENCE_REGISTRY.cycloneDxSbom,
				],
			},
			{
				controlId: "SI-12",
				title: "Information management & retention (erasure)",
				status: "implemented",
				evidence: [
					CONTROL_EVIDENCE_REGISTRY.subjectErasureRequestedEvent,
					CONTROL_EVIDENCE_REGISTRY.ocsfExport,
				],
			},
			{
				controlId: "AU-6",
				title: "Audit review, analysis & reporting",
				status: "implemented",
				evidence: [CONTROL_EVIDENCE_REGISTRY.ocsfExport],
			},
		],
	});
