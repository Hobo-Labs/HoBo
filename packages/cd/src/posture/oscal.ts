// OSCAL assessment results for recorded compliance (plan 0024 D25): maps the
// journal's ComplianceRecords onto @hobo/policy/posture's structural input
// and emits the OSCAL 1.1.2 document there (schema-validated in
// packages/policy/test/posture). Evidence, not attestation.
import {
	type OscalPostureAssessmentResults,
	type PostureComplianceInput,
	toOscalAssessmentResults,
} from "@hobo/policy/posture";
import type { ComplianceRecord } from "../_generated/cd_pb.js";
import { postureStateOf } from "./evaluate-camp.js";

export function toPostureComplianceInput(
	record: ComplianceRecord,
): PostureComplianceInput {
	return {
		campId: record.campId,
		railDigest: record.railDigest,
		candidate: record.candidate,
		state: postureStateOf(record.state),
		observationPosition: record.observationPosition,
		evaluatedAt: record.evaluatedAt,
		findings: record.findings.map((f) => ({
			rule: f.rule,
			resource: f.resource,
			state: postureStateOf(f.state),
			severity: f.severity,
			controls: [...f.controls],
			observed: f.observed,
			ownershipConflict: f.ownershipConflict,
		})),
	};
}

/** OSCAL assessment results for compliance records (throws PostureOscalError on an empty set). */
export function complianceOscal(
	records: readonly ComplianceRecord[],
	options: Readonly<{ title?: string }> = {},
): OscalPostureAssessmentResults {
	return toOscalAssessmentResults(
		records.map(toPostureComplianceInput),
		options,
	);
}
