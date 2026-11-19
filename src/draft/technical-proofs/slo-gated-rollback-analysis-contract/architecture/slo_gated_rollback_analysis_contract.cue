
package architecture_evidence

#SloGatedRollbackAnalysisContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SloGatedRollbackAnalysisContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
