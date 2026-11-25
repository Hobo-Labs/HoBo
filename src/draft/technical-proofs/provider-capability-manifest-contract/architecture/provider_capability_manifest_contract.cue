
package architecture_evidence

#ProviderCapabilityManifestContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderCapabilityManifestContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
