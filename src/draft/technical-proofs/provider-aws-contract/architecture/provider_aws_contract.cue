
package architecture_evidence

#ProviderAwsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderAwsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
