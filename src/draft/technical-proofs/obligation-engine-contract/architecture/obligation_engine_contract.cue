
package architecture_evidence

#ObligationEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ObligationEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
