// CUE constraints for the policy-delivery and posture records in cd.proto
// (WP24: D24, D25, I22, I23). Values are protobuf JSON (camelCase fields,
// enum names, uint64 as decimal strings); proto3 JSON omits defaults, so
// empty strings, false and zero do not appear.
// Self-contained (no package clause):
// `cue vet -c -d '#ComplianceRecord' posture.cue record.json`.
//
// Rules that need evaluation (ENFORCE only after an INFORM qualification,
// restore only of the latest bind, divergence = effects differ, ownership
// classification against the current Set) live in src/posture/;
// test/posture/cue.test.ts checks that both agree on what CUE can express.

import "strings"

#Digest:    =~"^sha256:[0-9a-f]{64}$"
#Timestamp: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Id:        string & !="" & strings.MaxRunes(256)
#Position:  =~"^[0-9]+$"
#UInt64:    =~"^[0-9]+$"
#Short:     string & strings.MaxRunes(256)
#Text:      string & strings.MaxRunes(4096)
#Effect:    "allow" | "allow-degraded" | "deny" | "warn" | "mutate" | "require-approval"
#Severity:  "info" | "low" | "medium" | "high" | "critical"
#Control:   =~"^[A-Za-z][A-Za-z0-9]*([.-][A-Za-z0-9]+)*$"

// `<pack>/<rule>`: both are posture profile ids.
#RuleKey: =~"^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?/[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$"

#ComplianceState: "COMPLIANCE_STATE_COMPLIANT" | "COMPLIANCE_STATE_NONCOMPLIANT" | "COMPLIANCE_STATE_UNKNOWN" | "COMPLIANCE_STATE_NOT_APPLICABLE"
#RemediationMode: "REMEDIATION_MODE_INFORM" | "REMEDIATION_MODE_INFORM_ONLY" | "REMEDIATION_MODE_ENFORCE"

#ReasonRecord: {
	code:         #Id
	message?:     #Text
	remediation?: #Text
	subject?:     #Short
}

// policy.BindingChanged body. A binding is written by promotion only and
// always names the Camp, the promotion and the instant. An INFORM bind sets
// the candidate; ENFORCE sets the enforced digest and clears the candidate;
// a restore of a Camp with no earlier enforced Rail clears both (the
// Station's active Rail decides again).
#PolicyBindingRecord: {
	campId:               #Id
	enforcedRailDigest?:  #Digest
	candidateRailDigest?: #Digest
	freightId?:           #Id
	promotionId:          #Id
	boundAt:              #Timestamp
	// A candidate never equals the enforced Rail.
	if enforcedRailDigest != _|_ && candidateRailDigest != _|_ {
		candidateRailDigest: !=enforcedRailDigest
	}
}

// policy.ShadowDecided body. `diverged` is derived from the two effects.
#ShadowDecisionRecord: {
	campId:              #Id
	deltaId:             #Id
	enforcedRailDigest?: #Digest
	candidateRailDigest: #Digest
	enforcedEffect:      #Effect
	candidateEffect:     #Effect
	diverged?:           true
	decidedAt:           #Timestamp
	if enforcedEffect == candidateEffect {diverged?: _|_}
	if enforcedEffect != candidateEffect {diverged!: true}
}

#PostureFindingRecord: {
	rule:      #RuleKey
	resource?: #Short
	state:     #ComplianceState
	severity:  #Severity
	controls?: [...#Control]
	observed?: #Short
	// Only an enforced, noncompliant finding can be an ownership conflict (I22).
	ownershipConflict?: true
	if ownershipConflict != _|_ {state: "COMPLIANCE_STATE_NONCOMPLIANT"}

	// A rule that matched no resource is not applicable, and only then.
	if resource == _|_ {state: "COMPLIANCE_STATE_NOT_APPLICABLE"}
}

// compliance.Observed / compliance.Changed body. It always names the
// observation position it evaluated (D25).
#ComplianceRecord: {
	campId:     #Id
	railDigest: #Digest
	candidate?: true
	state:      #ComplianceState
	findings?: [...#PostureFindingRecord]
	observationPosition: #Position
	evaluatedAt:         #Timestamp
	// Candidate Rails are shadowed, never enforced: no ownership conflicts.
	if candidate != _|_ {findings?: [...{ownershipConflict?: _|_}]}
}

// posture.RemediationProposed body. Only enforcement proposes remediation.
#PostureRemediationRecord: {
	campId:   #Id
	rule:     #RuleKey
	resource: #Short & !=""
	mode:     "REMEDIATION_MODE_ENFORCE"
	deltaId?: =~"^delta_posture_[0-9a-f]{24}$"
	reasons: [#ReasonRecord, ...#ReasonRecord]
}

#PolicyMode:     "POLICY_MODE_INFORM" | "POLICY_MODE_ENFORCE"
#FreightSubject: "FREIGHT_SUBJECT_BINDLE" | "FREIGHT_SUBJECT_RAIL"

#RailFailoverRecord: {
	automatic?:           bool
	maxConcurrent?:       int & >=0
	allowImmediatePurge?: bool
	requiredSignals?:     int & >=0
}

#RailEnrollmentRecord: {
	separateApprovers?: bool
	autoAcceptScopes?: [...#Id]
}

// The Rail's opaque `delivery` object as @hobo/cd parses it (D20, D24).
#RailDeliveryRecord: {
	railDigest: #Digest
	campSets?: [...#Id]
	posture?: [...#RailPostureBindingRecord]
	failover?:       #RailFailoverRecord
	enrollment?:     #RailEnrollmentRecord
	maxFanoutCamps?: int & >=0
}

// A Rail `delivery.posture` entry (parsed into RailDeliveryRecord).
#RailPostureBindingRecord: {
	pack:                    =~"^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$"
	remediation?:            #RemediationMode
	compliantIntervalMs?:    #UInt64
	noncompliantIntervalMs?: #UInt64
}
