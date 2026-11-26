package architecture_evidence

#S2StageGateEvidenceKind: "unspecified" | "drill-report" | "timeline"

#S2StageGateDrillRecord: {
	issue:            string & !=""
	fixture:          string & !=""
	provider:         string & !=""
	resume_budget_ms: int & >0 & <=30000
	gate_arms:        [...string] & [_, _, _, _, _]
}
