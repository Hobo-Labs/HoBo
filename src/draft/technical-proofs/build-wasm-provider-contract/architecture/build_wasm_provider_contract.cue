
package architecture_evidence

#BuildWasmProviderContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BuildWasmProviderContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
