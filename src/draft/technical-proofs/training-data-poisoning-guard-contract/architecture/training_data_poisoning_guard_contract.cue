
package architecture_evidence

#TrainingDataPoisoningGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TrainingDataPoisoningGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
