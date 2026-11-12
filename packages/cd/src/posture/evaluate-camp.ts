// One Camp's posture evaluation (plan 0024 D25) as a pure function of its
// recorded inputs: the bound packs, their remediation modes, the status
// observation (and its journal position), the current Set, the Camp's
// management mode and the instant. The posture service calls it on every
// due tick; replay calls it with the same recorded inputs and must get the
// same ComplianceRecord back.
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

const STATE: Readonly<Record<PostureState, ComplianceState>> = {
	compliant: ComplianceState.COMPLIANT,
	noncompliant: ComplianceState.NONCOMPLIANT,
	unknown: ComplianceState.UNKNOWN,
	"not-applicable": ComplianceState.NOT_APPLICABLE,
};

const STATE_NAME: Readonly<Record<number, PostureState>> = {
	[ComplianceState.COMPLIANT]: "compliant",
	[ComplianceState.NONCOMPLIANT]: "noncompliant",
	[ComplianceState.UNKNOWN]: "unknown",
	[ComplianceState.NOT_APPLICABLE]: "not-applicable",
};

export function postureStateOf(state: ComplianceState): PostureState {
	return STATE_NAME[state] ?? "unknown";
}

/** A remediation the service must act on: one noncompliant finding under an effective `enforce`. */
export type RemediationPlan = Readonly<{
	/** `<pack>/<rule>`, as recorded on findings. */
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
	/** Parsed packs, or undefined when a bound pack is missing or invalid (the record is then UNKNOWN). */
	packs: readonly PosturePack[] | undefined;
	/** Remediation mode per pack name, from the Rail's posture bindings. */
	modes: ReadonlyMap<string, RemediationMode>;
	observation: ReconcileObservationRecord;
	/** Decimal journal position of the status observation evaluated. */
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

/** Evaluate one Camp against one Rail's bound packs. Pure. */
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
	// Candidates are shadowed, never enforced; OBSERVE_ONLY Camps get posture in inform only (D25).
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

/**
 * The noncompliant ratio a compliance record carries: (noncompliant +
 * unknown) / applicable findings. An UNKNOWN record without findings (packs
 * unresolved) counts as fully noncompliant, so it can never read as healthy.
 */
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
