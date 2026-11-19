
package architecture_evidence

#TrainingEnginePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TrainingEnginePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
