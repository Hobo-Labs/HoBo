
package architecture_evidence

#ProviderHetznerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderHetznerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
