
package architecture_evidence

#GenerationProviderLoopContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationProviderLoopContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
