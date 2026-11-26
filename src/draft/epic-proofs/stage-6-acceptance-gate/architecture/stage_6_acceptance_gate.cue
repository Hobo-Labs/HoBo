// CUE constraints for Stage-6 acceptance drill records (HOBO-665).

package architecture_evidence

#StageGateStatus: "pass" | "fail"

#AcceptanceCheckId:
	"canary-auto-rollback" |
	"plan-time-cost-tolerance" |
	"dr-rebuild-rto" |
	"dashboard-a11y-audits" |
	"governance-evidence" |
	"prior-stage-gates"

#PriorStageGateRecord: {
	stage:         string & =~"^S[0-5]$"
	status:        #StageGateStatus
	evidenceRef:   string & !=""
}

#GovernanceEvidenceItem: {
	id:     "consent-gated-notify" | "residency-retention-crypto-shred" | "blocked-flagged-model-output" | "certified-only-registry-install"
	passed: bool
	detail: string
}

#Stage6AcceptanceCheck: {
	id:     #AcceptanceCheckId
	status: #StageGateStatus
	detail: string
}

#Stage6AcceptanceDrillResult: {
	issue:                    "HOBO-665"
	ok:                       bool
	checks:                   [...#Stage6AcceptanceCheck]
	priorGates:               [...#PriorStageGateRecord]
	governance:               [...#GovernanceEvidenceItem] & [_, _, _, _]
	v1GaChecklistComplete:    bool
}
