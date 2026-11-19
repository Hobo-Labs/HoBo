
package architecture_evidence

#BuildDaggerProviderContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BuildDaggerProviderContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
