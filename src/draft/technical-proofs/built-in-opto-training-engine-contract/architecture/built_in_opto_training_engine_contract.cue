
package architecture_evidence

#BuiltInOptoTrainingEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BuiltInOptoTrainingEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
