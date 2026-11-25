
package architecture_evidence

#SloComputationEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SloComputationEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
