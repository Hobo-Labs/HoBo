
package architecture_evidence

#ProviderPortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderPortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
