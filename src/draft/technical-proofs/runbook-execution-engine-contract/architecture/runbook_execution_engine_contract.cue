
package architecture_evidence

#RunbookExecutionEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RunbookExecutionEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
