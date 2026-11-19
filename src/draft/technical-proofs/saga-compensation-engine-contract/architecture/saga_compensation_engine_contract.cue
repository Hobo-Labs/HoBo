
package architecture_evidence

#SagaCompensationEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SagaCompensationEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
