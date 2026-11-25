
package architecture_evidence

#ProviderFlyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderFlyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
