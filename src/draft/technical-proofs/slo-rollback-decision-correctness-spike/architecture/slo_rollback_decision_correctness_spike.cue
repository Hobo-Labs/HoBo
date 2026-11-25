
package architecture_evidence

#SloRollbackDecisionCorrectnessSpikeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SloRollbackDecisionCorrectnessSpikeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
