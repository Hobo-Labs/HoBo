
package architecture_evidence

#OpenfeatureProviderAdaptersContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OpenfeatureProviderAdaptersContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
