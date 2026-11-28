import { create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import {
	effectiveRemediation,
	evaluatePosture,
	type PostureFix,
	type PosturePack,
	type PostureRule,
	type PostureState,
	type RemediationMode,
} from "@hobo/policy/posture";
import {
	CampManagement,
	type ComplianceRecord,
	ComplianceRecordSchema,
	ComplianceState,
	type PostureFindingRecord,
	PostureFindingRecordSchema,
	type ReconcileObservationRecord,
} from "../_generated/cd_pb.js";
import { classifyOwnership, type Ownership } from "./ownership.js";

const STATE = {
	compliant: ComplianceState.COMPLIANT,
	noncompliant: ComplianceState.NONCOMPLIANT,
	unknown: ComplianceState.UNKNOWN,
	"not-applicable": ComplianceState.NOT_APPLICABLE,
} as const satisfies Record<PostureState, ComplianceState>;

export function postureStateOf(state: ComplianceState): PostureState {
	switch (state) {
		case ComplianceState.COMPLIANT:
			return "compliant";
		case ComplianceState.NONCOMPLIANT:
			return "noncompliant";
		case ComplianceState.NOT_APPLICABLE:
			return "not-applicable";
		default:
			return "unknown";
	}
}

export type RemediationPlan = Readonly<{
	rule: string;
	resource: string;
	ownership: Ownership;
	conflicting: readonly string[];
	fixes: readonly PostureFix[];
}>;

export type CampEvaluationInput = Readonly<{
	campId: string;
	railDigest: string;
	candidate: boolean;
	packs: readonly PosturePack[] | undefined;
	modes: ReadonlyMap<string, RemediationMode>;
	observation: ReconcileObservationRecord;
	position: string;
	resolved: ResolvedDeploymentSet | undefined;
	management: CampManagement;
	evaluatedAt: string;
}>;

export type CampEvaluation = Readonly<{
	record: ComplianceRecord;
	remediations: readonly RemediationPlan[];
}>;

export function ruleKey(rule: Readonly<{ pack: string; id: string }>): string {
	return `${rule.pack}/${rule.id}`;
}

export function evaluateCamp(input: CampEvaluationInput): CampEvaluation {
	const base = {
		campId: input.campId,
		railDigest: input.railDigest,
		candidate: input.candidate,
		observationPosition: input.position,
		evaluatedAt: input.evaluatedAt,
	};
	if (!input.packs) {
		return {
			record: create(ComplianceRecordSchema, {
				...base,
				state: ComplianceState.UNKNOWN,
				findings: [],
			}),
			remediations: [],
		};
	}
	const rules: PostureRule[] = input.packs.flatMap((pack) => [...pack.rules]);
	const evaluation = evaluatePosture(rules, {
		resources: input.observation.resources.map((r) => ({
			resource: r.resource,
			kind: r.kind,
			classification: r.classification,
			attributes: { ...r.attributes },
		})),
	});
	const packByName = new Map(input.packs.map((pack) => [pack.pack, pack]));
	const ruleByKey = new Map(rules.map((rule) => [ruleKey(rule), rule]));
	const mayEnforce =
		!input.candidate && input.management !== CampManagement.OBSERVE_ONLY;
	const remediations: RemediationPlan[] = [];
	const findings: PostureFindingRecord[] = evaluation.findings.map(
		(finding) => {
			const key = ruleKey({ pack: finding.pack, id: finding.rule });
			const rule = ruleByKey.get(key);
			const pack = packByName.get(finding.pack);
			let ownershipConflict = false;
			if (mayEnforce && rule && pack && finding.state === "noncompliant") {
				const binding = input.modes.get(pack.pack) ?? "inform";
				if (effectiveRemediation({ binding, pack, rule }) === "enforce") {
					const retained =
						input.observation.resources.find(
							(r) => r.resource === finding.resource,
						)?.retained ?? [];
					const verdict = classifyOwnership({
						rule,
						finding,
						resolved: input.resolved,
						retained,
					});
					ownershipConflict = verdict.ownership === "conflict";
					remediations.push({
						rule: key,
						resource: finding.resource,
						ownership: verdict.ownership,
						conflicting: verdict.conflicting,
						fixes: rule.fix,
					});
				}
			}
			return create(PostureFindingRecordSchema, {
				rule: key,
				resource: finding.resource,
				state: STATE[finding.state],
				severity: finding.severity,
				controls: [...finding.controls],
				observed: finding.observed,
				ownershipConflict,
			});
		},
	);
	return {
		record: create(ComplianceRecordSchema, {
			...base,
			state: STATE[evaluation.state],
			findings,
		}),
		remediations,
	};
}

export function noncompliantRatio(record: ComplianceRecord): number {
	if (record.state === ComplianceState.UNKNOWN && record.findings.length === 0)
		return 1;
	const applicable = record.findings.filter(
		(f) => f.state !== ComplianceState.NOT_APPLICABLE,
	);
	if (applicable.length === 0) return 0;
	const failing = applicable.filter(
		(f) =>
			f.state === ComplianceState.NONCOMPLIANT ||
			f.state === ComplianceState.UNKNOWN,
	);
	return failing.length / applicable.length;
}
