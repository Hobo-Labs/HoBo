
package architecture_evidence

#ProviderGcpContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderGcpContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
