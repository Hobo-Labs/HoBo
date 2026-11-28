
package architecture_evidence

#PolicyEngineProviderAdaptersContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyEngineProviderAdaptersContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
