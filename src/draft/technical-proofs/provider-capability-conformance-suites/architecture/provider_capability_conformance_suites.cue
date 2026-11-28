
package architecture_evidence

#ProviderCapabilityConformanceSuitesEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderCapabilityConformanceSuitesRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
